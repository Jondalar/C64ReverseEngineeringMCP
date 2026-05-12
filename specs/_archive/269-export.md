# Spec 269 — Screenshot / video / audio export

**Sprint:** 141
**Status:** PROPOSED 2026-05-09
**Master:** 260
**Parallel-eligible with:** 271

## Goal

Export PNG screenshots, MP4 video (with audio), WAV audio
standalone. Server-side encode via ffmpeg. Output written to
project dir or user-chosen path.

## Formats

- **PNG**: single frame, palette-perfect 384×272 or larger
  (configurable scale 1x/2x/4x).
- **MP4**: H264 + AAC audio, 50fps PAL, 60s+ supported.
- **WAV**: lossless PCM, sample rate 44.1kHz stereo s16le.
- **APNG / GIF**: animated bookmark-able. Defer to V3.x.

## ffmpeg pipeline (video)

1. UI request: `runtime_export_video <scenarioId> [--duration N]`
2. Server runs scenario fresh from start (= deterministic per
   Spec 231)
3. Per-frame: emit raw RGBA to ffmpeg stdin via pipe
4. Per-N-samples: emit s16le audio to second pipe
5. ffmpeg merges video+audio → mp4 file
6. UI shows progress (= polling or WebSocket event)
7. Done → download link surfaces

## ffmpeg invocation

```
ffmpeg -f rawvideo -pixel_format rgba -video_size 384x272 -framerate 50 -i pipe:3 \
       -f s16le -ar 44100 -ac 2 -i pipe:4 \
       -c:v libx264 -preset slow -crf 18 \
       -c:a aac -b:a 128k \
       output.mp4
```

System dep: ffmpeg installed (homebrew on mac). CLAUDE.md adds
note to install.

## MCP tools

- `runtime_export_screenshot <scenarioId> <outPath> [--scale N] [--at-cycle N]`
- `runtime_export_video <scenarioId> <outPath> [--duration N] [--scale N]`
- `runtime_export_audio <scenarioId> <outPath> [--duration N] [--format wav|flac]`

UI buttons in Live + Scenarios tabs. "Snap" button = single PNG
of current state. "Record" button = video export configurator.

## Acceptance

- Snap motm title → PNG file 384×272, opens in any image viewer
- Export 30s motm-intro video (mp4) → plays in QuickTime/VLC
  with audio
- Export 60s SID tune (wav) → plays cleanly
- Determinism: 2x export same scenario → byte-equal mp4 (= modulo
  ffmpeg encode timestamp metadata)

## Out of scope

- Hardware-accelerated H264 encoder
- 4K upscale (= V3.x)
- Streaming export (= live record-while-running)
