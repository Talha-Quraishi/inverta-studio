# Security Policy

## 🔒 Client-Side Privacy Guarantee

Inverta Studio is architected from the ground up as a **100% private, client-side application**:
- **Zero Server Uploads**: Your images and videos never leave your machine.
- **In-Memory Processing**: Media frames are decoded and reconstructed entirely in local browser RAM using hardware-accelerated Canvas 2D and the WebCodecs API.
- **Zero Tracking**: We do not use third-party analytics, tracking cookies, or tracking pixels.

---

## 🛡️ Supported Versions

We actively maintain the latest release deployed on GitHub Pages (`main` branch):

| Version | Supported          |
| ------- | ------------------ |
| 2.6.x   | :white_check_mark: |
| < 2.5.0 | :x:                |

---

## 🚨 Reporting a Vulnerability

If you discover a security vulnerability or client-side integrity issue in Inverta Studio:

1. **Do not disclose it publicly** via GitHub Issues or social media.
2. Please open a [Private Security Advisory](https://github.com/Talha-Quraishi/inverta-studio/security/advisories/new) on GitHub.
3. Include:
   - A description of the vulnerability.
   - Steps to reproduce or proof-of-concept.
   - Affected browser(s) and operating system(s).

We will review reports within 48 hours and work with you to verify and patch the issue promptly.
