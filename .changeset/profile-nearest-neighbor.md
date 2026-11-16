---
"@furrow/cam-core": minor
---

Profile operations optimize cutting sequences using multi-start Nearest-Neighbor (trying each eligible contour as the first cut), 2-Opt inversions, and Or-Opt single-node relocations until no move reduces total rapid travel distance. Closed contours and circles dynamically rotate their start/entry points to the closest point facing the incoming cut rather than using a fixed DXF entity index, while strictly keeping inner contours cut before enclosing outlines.
