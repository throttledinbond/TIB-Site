#!/usr/bin/env python3
"""
TIB Website — Static Security Scanner
=====================================
Client-side static analysis for the single-file Throttled In Bond web app.
Reads the HTML/JS source and flags likely security issues WITHOUT touching the
network (safe to run anywhere, including scheduled jobs).

Usage:
    python3 tib_security_scan.py /path/to/tib-site-index.html
    python3 tib_security_scan.py /path/to/file.html --json report.json

Findings each have a severity: CRITICAL / HIGH / MEDIUM / LOW / INFO.
Exit code = number of CRITICAL+HIGH findings (0 = clean of high-sev issues),
so CI / scheduled tasks can gate on it.

NOTE: This covers the CLIENT-SIDE surface only. The Supabase backend
(RLS, policies, function privileges, auth config) is checked separately via
the Supabase advisors + SQL probe suite documented in the VM plan.
"""

import re
import sys
import json
import html
from datetime import datetime, timezone

SEV_ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "INFO": 4}


def line_of(text, idx):
    return text.count("\n", 0, idx) + 1


def add(findings, sev, check, msg, line=None, evidence=None):
    findings.append({
        "severity": sev,
        "check": check,
        "message": msg,
        "line": line,
        "evidence": (evidence[:120] + "…") if evidence and len(evidence) > 120 else evidence,
    })


# --- Secret / credential patterns -------------------------------------------
SECRET_PATTERNS = [
    ("CRITICAL", "brevo_api_key", re.compile(r"xkeysib-[A-Za-z0-9]{40,}")),
    ("CRITICAL", "sendgrid_api_key", re.compile(r"SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}")),
    ("CRITICAL", "aws_access_key", re.compile(r"AKIA[0-9A-Z]{16}")),
    ("CRITICAL", "stripe_secret_key", re.compile(r"sk_live_[0-9A-Za-z]{16,}")),
    ("CRITICAL", "google_api_key", re.compile(r"AIza[0-9A-Za-z_\-]{35}")),
    ("CRITICAL", "openai_key", re.compile(r"sk-[A-Za-z0-9]{32,}")),
    ("CRITICAL", "supabase_service_role", re.compile(r"service_role")),
    ("HIGH", "generic_api_key_header", re.compile(r"['\"]?api-?key['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]", re.I)),
    ("HIGH", "bearer_token_literal", re.compile(r"Bearer\s+[A-Za-z0-9_\-\.]{20,}")),
    ("HIGH", "private_key_block", re.compile(r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----")),
]


def scan(path):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        text = f.read()

    findings = []

    # 1) Hardcoded secrets
    for sev, name, pat in SECRET_PATTERNS:
        seen = set()
        for m in pat.finditer(text):
            ln = line_of(text, m.start())
            key = (name, m.group(0))
            if key in seen:
                # still report each line occurrence
                pass
            seen.add(key)
            add(findings, sev, name,
                f"Possible hardcoded secret ({name}) in client source — anyone can read it via View Source.",
                ln, m.group(0))

    # 2) Supabase anon/publishable key (EXPECTED to be public — informational)
    for m in re.finditer(r"createClient\(", text):
        ln = line_of(text, m.start())
        add(findings, "INFO", "supabase_client_init",
            "Supabase client initialized. The anon/publishable key here is PUBLIC by design; "
            "security must rely on Row-Level Security, not key secrecy.", ln)

    # 3) External <script>/<link> without Subresource Integrity (SRI)
    for m in re.finditer(r"<script\b[^>]*\bsrc=[\"']([^\"']+)[\"'][^>]*>", text, re.I):
        tag = m.group(0)
        src = m.group(1)
        if src.startswith("http") and "integrity=" not in tag.lower():
            ln = line_of(text, m.start())
            add(findings, "MEDIUM", "missing_sri",
                "External script loaded without Subresource Integrity (integrity=...). "
                "A compromised CDN could inject code.", ln, src)

    # 4) target=_blank without rel=noopener (reverse tabnabbing)
    for m in re.finditer(r"<a\b[^>]*target=[\"']_blank[\"'][^>]*>", text, re.I):
        tag = m.group(0)
        if "noopener" not in tag.lower():
            ln = line_of(text, m.start())
            add(findings, "LOW", "tabnabbing",
                "Link opens in a new tab without rel=\"noopener\" — target page can access window.opener.",
                ln, tag)

    # 5) Non-HTTPS resource URLs
    for m in re.finditer(r"[\"'(]http://[^\"')\s]+", text):
        ln = line_of(text, m.start())
        add(findings, "MEDIUM", "insecure_http",
            "Insecure http:// resource reference (should be https://).", ln, m.group(0))

    # 6) innerHTML sinks — XSS surface heuristic
    innerhtml_count = len(re.findall(r"\.innerHTML\s*=", text))
    if innerhtml_count:
        add(findings, "INFO", "innerhtml_sinks",
            f"{innerhtml_count} assignment(s) to .innerHTML found. Ensure any user-controlled "
            f"data (names, emails, notes, feedback) is HTML-escaped before insertion to prevent stored XSS.")

    # 7) Rendering common user-controlled fields into HTML without an escape helper (heuristic)
    risky_fields = ["full_name", "display_name", "whiskey_name", "vin_code", "email", "city", "message"]
    has_escaper = bool(re.search(r"function\s+(fbEscape|escapeHtml|esc)\b", text))
    for field in risky_fields:
        # look for `+ x.field +` style concatenation into html strings
        for m in re.finditer(r"\+\s*[A-Za-z_]\w*\.%s\b" % re.escape(field), text):
            ln = line_of(text, m.start())
            # crude: flag if the same statement doesn't call an escaper
            window = text[max(0, m.start()-60):m.start()+60]
            if not has_escaper or ("Escape(" not in window and "escapeHtml(" not in window):
                add(findings, "HIGH", "unescaped_user_field",
                    f"User-controlled field '{field}' appears concatenated into HTML without an obvious "
                    f"escape call — potential stored XSS. Verify it is escaped.", ln, window.strip())
            break  # one representative hit per field is enough

    # 8) console.log left in production (info leak / noise)
    logs = len(re.findall(r"console\.log\(", text))
    if logs:
        add(findings, "LOW", "console_logging",
            f"{logs} console.log call(s) present. Remove verbose logging in production to avoid leaking internals.")

    # 9) eval / Function constructor
    for m in re.finditer(r"\beval\s*\(|new\s+Function\s*\(", text):
        ln = line_of(text, m.start())
        add(findings, "HIGH", "dynamic_code_exec",
            "Dynamic code execution (eval/new Function) detected — avoid; it enables code injection.", ln, m.group(0))

    # 10) Content-Security-Policy meta present?
    if not re.search(r"http-equiv=[\"']Content-Security-Policy[\"']", text, re.I):
        add(findings, "MEDIUM", "no_csp",
            "No Content-Security-Policy <meta> tag found. A CSP significantly reduces XSS impact. "
            "(GitHub Pages can't set CSP headers, but a <meta> CSP works.)")

    return findings, {
        "file": path,
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "size_bytes": len(text.encode("utf-8")),
    }


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("Usage: python3 tib_security_scan.py <file.html> [--json out.json]")
        sys.exit(2)
    path = args[0]
    json_out = None
    if "--json" in sys.argv:
        i = sys.argv.index("--json")
        if i + 1 < len(sys.argv):
            json_out = sys.argv[i + 1]

    findings, meta = scan(path)
    findings.sort(key=lambda x: (SEV_ORDER.get(x["severity"], 9), x["check"]))

    counts = {}
    for f in findings:
        counts[f["severity"]] = counts.get(f["severity"], 0) + 1

    print("=" * 68)
    print("TIB WEBSITE — STATIC SECURITY SCAN")
    print("=" * 68)
    print(f"File     : {meta['file']}")
    print(f"Scanned  : {meta['scanned_at']}")
    print(f"Size     : {meta['size_bytes']:,} bytes")
    print("-" * 68)
    summary = "  ".join(f"{k}:{counts.get(k,0)}" for k in ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"])
    print("Summary  : " + summary)
    print("-" * 68)
    for f in findings:
        loc = f" (line {f['line']})" if f.get("line") else ""
        print(f"[{f['severity']:<8}] {f['check']}{loc}")
        print(f"           {f['message']}")
        if f.get("evidence"):
            print(f"           evidence: {f['evidence']}")
    print("=" * 68)

    if json_out:
        with open(json_out, "w") as jf:
            json.dump({"meta": meta, "counts": counts, "findings": findings}, jf, indent=2)
        print(f"JSON written to {json_out}")

    highs = counts.get("CRITICAL", 0) + counts.get("HIGH", 0)
    sys.exit(highs)


if __name__ == "__main__":
    main()
