#!/usr/bin/env python3
"""Timestamp and de-spam the gateway's log stream.

Sits in the pipe in ``start-gateway.sh``: the gateway's merged stdout/stderr
flows through here before launchd writes it to ``/tmp/str-bot-gateway.log``.

WHY THIS EXISTS, AND WHY IT IS HERE RATHER THAN IN THE FRAMEWORK

1. Timestamps. The gateway's log formatter is hardcoded in the vendored hermes
   framework as ``'%(levelname)s %(name)s: %(message)s'`` — no ``asctime``, and
   ``logging:`` in config.yaml only exposes level/size/count. Every 2026-09-11
   and 2026-10-12 diagnosis was slowed by having to infer event ordering from
   byte position in the file. Patching the framework would work but is
   machine-local and gets wiped by a reinstall; stamping in the pipe lives in
   this repo and also covers output the Python formatter never touches —
   slack_bolt tracebacks, aiohttp errors, npm/node warnings.

2. Repeat suppression. On 2026-08-10 and again through 2026-09/10 the Slack
   socket died into an unrecoverable retry loop and wrote **721,686** copies of
   the same ``Session is closed`` traceback — 190 MB, 99.4% of the file, which
   made grep-based diagnosis actively misleading. Real backoff belongs in
   slack_sdk, which is third-party and would be wiped by pip; and backoff is
   the wrong fix regardless, because that condition never recovers. This caps
   the *damage* instead: a runaway line is logged, then counted, then
   summarized, so the signal around it stays readable.

   This is deliberately NOT socket backoff, and it does not make a dead socket
   recover. The remedy for that remains a gateway restart
   (``launchctl kickstart -k gui/$(id -u)/com.longitude.pre-bot.gateway``).

DESIGN CONSTRAINT: this process sits between the gateway and its only log. It
must never crash, never buffer, and never lose a line it has not accounted for.
Every failure path falls back to passing the line through unchanged.

Usage:  <producer> 2>&1 | python3 scripts/hermes/log-stamp.py
Env:    LOG_STAMP_MAX_REPEATS   identical lines per window before suppressing (default 20)
        LOG_STAMP_WINDOW_SECONDS  sliding window length (default 60)
        LOG_STAMP_DISABLE=1     pass everything through, stamped but unsuppressed
"""
from __future__ import annotations

import os
import signal
import sys
import time

MAX_REPEATS = int(os.environ.get("LOG_STAMP_MAX_REPEATS", "20") or 20)
WINDOW_SECONDS = float(os.environ.get("LOG_STAMP_WINDOW_SECONDS", "60") or 60)
DISABLED = os.environ.get("LOG_STAMP_DISABLE", "") == "1"

# A repeating failure is a repeating *block* (ERROR line, "Traceback", several
# "  File ..." frames, the exception), not one repeated line — so counting has
# to be per-signature over a sliding window, not consecutive-duplicate.
# Signature = the line itself, trimmed and capped: identical enough to collapse,
# cheap to hash, and it keeps distinct messages distinct.
SIGNATURE_CAP = 200


def stamp() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def main() -> int:
    # Dying quietly if the consumer goes away is correct for a pipe stage.
    try:
        signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    except (AttributeError, ValueError, OSError):
        pass

    out = sys.stdout
    counts: dict[str, int] = {}
    suppressed: dict[str, int] = {}
    window_start = time.monotonic()

    def flush_window_summary() -> None:
        """Report what was withheld, so suppression is never silent."""
        if not suppressed:
            return
        for sig, n in sorted(suppressed.items(), key=lambda kv: -kv[1]):
            out.write(
                f"{stamp()} [log-stamp] suppressed {n} further occurrence(s) "
                f"in the last {int(WINDOW_SECONDS)}s of: {sig}\n"
            )
        out.flush()
        suppressed.clear()

    while True:
        try:
            line = sys.stdin.readline()
        except (KeyboardInterrupt, SystemExit):
            break
        except Exception:
            # Never die on a read hiccup; a decode error must not end logging.
            continue
        if not line:
            break

        try:
            now = time.monotonic()
            if now - window_start >= WINDOW_SECONDS:
                flush_window_summary()
                counts.clear()
                window_start = now

            if DISABLED:
                out.write(f"{stamp()} {line}")
                out.flush()
                continue

            sig = line.strip()[:SIGNATURE_CAP]
            if not sig:
                out.write(f"{stamp()} {line}")
                out.flush()
                continue

            n = counts.get(sig, 0) + 1
            counts[sig] = n
            if n <= MAX_REPEATS:
                out.write(f"{stamp()} {line}")
                if n == MAX_REPEATS:
                    out.write(
                        f"{stamp()} [log-stamp] '{sig[:120]}' hit {MAX_REPEATS} occurrences "
                        f"in under {int(WINDOW_SECONDS)}s — suppressing further copies this window\n"
                    )
                out.flush()
            else:
                suppressed[sig] = suppressed.get(sig, 0) + 1
        except BrokenPipeError:
            break
        except Exception:
            # Last resort: the line still gets out, unstamped if need be.
            try:
                out.write(line)
                out.flush()
            except Exception:
                break

    try:
        flush_window_summary()
        out.flush()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        sys.exit(0)
