# Team photos

`anthony.jpg` and `megan.jpg` here appear on printed reports next to the
presenter's name. These are the real headshots, square-cropped from the originals. To swap one,
**replace the file keeping the same filename** and the app picks it up
automatically; no code change. Square crops around the face work best.

Square crops look best (shown as circles, up to 44px on paper, so 200x200+
is plenty). To regenerate a placeholder: `node tools/make-team-placeholders.mjs --force`.
