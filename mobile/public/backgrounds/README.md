# Background drone shots

Drop your clips here, then list them in `src/backgrounds.ts`.

Best results:
- **Format:** MP4 (H.264, `yuv420p`) plays everywhere, including iPhone. WebM (VP9/AV1) is smaller but pair it with an MP4 fallback for Safari.
- **Resolution:** 1920×1080 (or 1280×720 for mobile). 4K is overkill behind blurred glass.
- **Length / size:** 10–30 s seamless loop, aim for under 10–15 MB. No audio track needed.
- **Shot:** slow, steady drone movement (orbit, slow push or pan) with a calm centre so the text stays readable.
- **Poster:** a `.jpg` still of the first frame shows instantly while the video loads.

Convert any clip with ffmpeg:

    ffmpeg -i input.mov -an -vf "scale=1920:-2,fps=30" -c:v libx264 -crf 26 -preset slow -pix_fmt yuv420p -movflags +faststart my-shot.mp4
    ffmpeg -i my-shot.mp4 -frames:v 1 -q:v 3 my-shot.jpg
