---
description: On a G64, checksum failures that rise with the speed zone are a capture artefact — not copy protection.
paths: ["**/*.g64"]
tools: ["analyze_g64_anomalies", "inspect_g64_track", "inspect_g64_syncs", "scan_g64_headers", "extract_g64_sectors"]
---

# Read the failure distribution before calling it protection

A G64 whose sectors fail their checksums invites one conclusion, and it is usually the
wrong one. Before "copy protection" is written down anywhere, plot the failures against
the **speed zone**:

- failures **rising with track number** (the slower outer zones) — a capture artefact.
  The source drive read the denser zones cleanly and the slower ones marginally. Nothing
  on the disk is defending itself.
- failures **clustered on specific tracks regardless of zone**, or a track whose sync
  or header structure differs from its neighbours — that is worth investigating as
  protection.

An unattended run recorded copy protection on four Neuromancer sides that carry none,
and no automated check could contradict it: no graph relation says a disk is unprotected.
The claim was structurally perfect and false, which is more expensive than an obviously
incomplete project, because completeness gets inferred from structure.

`inspect_g64_syncs`, `inspect_g64_track` and `scan_g64_headers` answer this statically.
Protection is a claim about *drive code*, so it is settled by reading drive code.

**What refuses later.** S2 (medium) gates `extract_disk_custom_lut` until the GCR verdict
— standard or custom — is recorded. And the substrate gate refuses runtime discovery on a
standard-GCR medium outright: a packed payload on a DOS-readable disk is a depack problem,
not a physics problem.
