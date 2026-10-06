#!/usr/bin/env python3
"""werewolf / make_avatar_parts.py — the layered avatar parts (纸娃娃素材), ANIME pass.

WHY GENERATED RATHER THAN DOWNLOADED: a paper-doll only works if every part shares
the same anchor geometry. Parts collected from different sources never line up (a
hairline from set A does not sit on the head from set B), so the parts are authored
together against ONE reference: a 120x120 box, head centred at (60,60) r=24.

Every file is a SOLID SILHOUETTE with no colour of its own. The client paints them
with CSS `mask-image`, so ONE hair file yields every hair colour at runtime -- no
combinatorial explosion of files, and recolouring is instant.

BECAUSE THE COLOUR COMES FROM CSS, ALL "DETAIL" HAS TO BE SHAPE:
  * a strand is a V notch or a pointed tip in the silhouette (never an inner line,
    which would have to be a different colour to be visible);
  * an eye highlight is a genuine HOLE in the eye shape (fill-rule=evenodd), which
    lets the SKIN behind show through -- that is what makes it read as a shine;
  * a seam or plate line is a HOLE too, cut with evenodd, revealing what is behind.
Holes are only used where the shape does not self-overlap, because evenodd CANCELS
overlaps; separate solid pieces are therefore appended as their own subpaths.

ANIME PASS (this revision): big high-set eyes with an upper lash and a highlight hole,
thin angular brows, spiky fringe with cut-in strands, side locks framing the face, an
ahoge (the stray cowlick) on the loose styles, pointed elf/wolf ears and cel-styled
accessories. The 120x120 anchor, the slot names and their ORDER are unchanged --
the 14-char avatar code indexes into these lists, so reordering would silently change
every existing player's look.

Run: python3 make_avatar_parts.py   ->  assets/img/avatar/<slot>_<shape>.svg
"""
import os

OUT = os.path.join(os.path.dirname(__file__), 'assets', 'img', 'avatar')

# ---- reference geometry (shared by EVERY part; this is what makes them match) ----
HEAD_CX, HEAD_CY, HEAD_R = 60, 60, 24


def mir(body):
    """Author the viewer-LEFT half once and mirror it, so faces stay symmetrical."""
    return body + '<g transform="translate(120 0) scale(-1 1)">' + body + '</g>'


# A fringe: the skull cap arcs over the head, then the lower edge is a comb of
# pointed locks. The notches ARE the strands -- that is all the detail a
# single-colour silhouette can carry, and it is exactly how anime bangs read.
CAP = 'M33 62 C31 38 45 29 60 29 C75 29 89 38 87 62'
FRINGE = 'L83 48 L79 53 L75 44 L71 52 L66 43 L62 52 L58 43 L53 52 L49 44 L45 53 L41 48 L37 54'
# Crown gloss: the anime "angel ring". A lens wound the OPPOSITE way round, so it
# punches a HOLE in the hair silhouette (skin shows through) instead of filling dark —
# the only way to draw a highlight in a single-colour mask.
GLOSS = ' M38 41 C46 37 74 37 82 41 C74 32 46 32 38 41 Z'
SHORT = CAP + FRINGE + ' Z' + GLOSS
# Side locks: taper to a point at the jaw so the face is framed, not just topped.
SIDELOCK = 'M34 62 C31 72 33 81 38 87 L44 82 C40 75 38 68 39 60 Z'
# The ahoge. Kept SHORT on purpose: avFit() scales the doll by the topmost part, so a
# long antenna would shrink the head inside the frame for a 2-unit sliver of hair.
AHOGE = 'M55 32 C54 28 56 24 60 23 C57 27 56 29 58 33 Z'

PARTS = {
    # ---------------- body: shoulders / outfit ----------------
    'body': {
        # Cape with a collar opening cut at the throat and pointed shoulder line.
        'cloak':  '<path fill-rule="evenodd" d="M4 120 Q10 88 44 84 L60 97 L76 84 Q110 88 116 120 Z M56 98 a3 3 0 1 0 8 0 a3 3 0 1 0 -8 0 Z"/>',

        # Tunic: raised collar, centre placket (a real hole), hem band.
        'tunic':  '<path fill-rule="evenodd" d="M16 120 Q20 92 46 88 L46 81 L74 81 L74 88 '
                  'Q100 92 104 120 Z M58 88 H62 V117 H58 Z"/>',

        # Armour: pauldrons, chest plate, two plate seams cut through.
        'armor':  '<path fill-rule="evenodd" d="M10 120 Q16 92 42 86 L60 93 L78 86 Q104 92 110 120 Z '
                  'M26 101 H94 V103.6 H26 Z M30 109 H90 V111.6 H30 Z"/>',

    },
    # ---------------- head: the anchor everything else matches ----------------
    'head': {
        'round':  f'<circle cx="{HEAD_CX}" cy="{HEAD_CY}" r="{HEAD_R}"/>',
        'oval':   f'<ellipse cx="{HEAD_CX}" cy="{HEAD_CY}" rx="22.4" ry="25"/>',
        # A jaw with an actual chin instead of a boxy square.
        'square': '<path d="M37 44 Q60 34 83 44 V60 Q83 76 72 82 Q60 88 48 82 Q37 76 37 60 Z"/>',
    },
    # ---------------- ears: poke out from behind the hair ----------------
    'ears': {
        'none':   '',
        # Tall wolf ear with an inner-ear hole (the skin behind shows through).
        'wolf':   '<path fill-rule="evenodd" d="M36 50 L29 19 Q42 27 51 39 L45 48 Z '
                  'M37 41 L33 28 Q39 32 43 37 Z"/>', 
        # Pointed elf ear.
        'small':  mir('<path d="M36 59 Q29 53 31 44 Q38 51 43 56 Z"/>'),
        # Hair tuft, in the hair colour, with a pointed tip.
        'tuft':   mir('<path d="M34 47 Q31 33 41 28 Q39 40 43 47 Z"/>'),
    },
    # ---------------- hair: sits on the crown of the head ----------------
    'hair': {
        'bald':   '',
        'short':  '<path d="' + SHORT + '"/>' + mir('<path d="' + SIDELOCK + '"/>')
                  + '<path d="' + AHOGE + '"/>',
        # Long: the same head, plus back hair falling past the shoulders with
        # strand notches cut into the outer contour.
        'long':   '<path d="' + SHORT + '"/>' + mir('<path d="' + SIDELOCK + '"/>')
                  + mir('<path d="M29 58 C23 80 25 99 33 112 L40 108 L35 96 L42 100 L38 86 '
                        'L45 90 L40 74 L46 78 C40 70 38 64 39 58 Z"/>'),
        # Pony: high tail tied at the side, tapering to a point with a strand split.
        'pony':   '<path d="' + SHORT + '"/>' + mir('<path d="' + SIDELOCK + '"/>')
                  + '<path d="M76 34 Q94 36 104 52 Q113 68 104 84 L97 79 L101 64 L93 70 '
                  'L96 56 L88 62 Q92 45 82 40 Z"/>'
                  + '<path d="M74 33 Q82 30 88 38 L82 42 Q79 37 73 38 Z"/>',
        # Bun: wound up with two strand cuts, plus the wrapped band.
        'bun':    '<path fill-rule="evenodd" d="M60 13 a11 11 0 1 0 0.01 0 Z '
                  'M52 22 Q60 17 68 22 M51 28 Q60 23 69 28"/>' 
                  + '<path d="M50 32 Q60 26 70 32 L68 36 Q60 31 52 36 Z"/>'
                  + '<path d="' + SHORT + '"/>' + mir('<path d="' + SIDELOCK + '"/>'),
        'mohawk': '<path d="M50 46 Q52 24 58 18 Q64 12 68 20 Q74 26 76 46 '
                  'Q68 40 63 41 Q56 42 50 46 Z"/>'
                  + '<path d="M48 58 Q54 52 60 53 Q68 54 72 58 L70 62 Q62 58 56 58 Q51 58 48 58 Z"/>',
        # Wild: a spiky crown of uneven locks.
        'wild':   '<path d="M33 63 L29 45 L37 51 L35 30 L44 43 L46 23 L52 41 L58 20 L63 41 '
                  'L69 23 L71 43 L80 30 L78 51 L86 45 L87 63' + FRINGE + ' Z"/>'
                  + mir('<path d="' + SIDELOCK + '"/>')
                  + '<path d="M54 30 C52 24 55 18 60 16 C56 22 55 26 57 31 Z"/>',
    },
    # ---------------- brows: painted in the HAIR colour, so expression matches -----
    'brows': {
        'neutral': mir('<path d="M43.2 47 Q48.4 44.2 55.6 45.8 L55.2 48.2 Q48.6 46.6 43.8 49.4 Z"/>'),
        'angry':   mir('<path d="M43.2 44.6 Q48.4 45 55.6 50.4 L54 52 Q48.6 47.4 43.8 47.2 Z"/>'),
        'worried': mir('<path d="M43.2 50 Q48.6 46 55.6 44.8 L55.8 47 Q48.8 48.2 44.2 51.8 Z"/>'),
        'raised':  mir('<path d="M43.6 43.6 Q48.4 39.6 55.6 42 L55.2 44.4 Q48.6 42 44.2 45.8 Z"/>'),
    },
    # ---------------- eyes ----------------
    # Big, high-set, with a heavy upper lid and a highlight cut clean through the
    # shape so the skin behind it reads as a shine. Author the left eye, mirror it.
    # ---------------- eyes ----------------
    # Genshin-ish: a bold mass that still reads at 34px, THREE hole speculars
    # (upper orb, lower spark, and the lower-rim crescent = the ring light that
    # makes an eye look DRAWN), plus a thick lash with an outer flick, a lower
    # lid line and a crease. Holes are kept apart: evenodd cancels overlaps.
    # ---------------- eyes ----------------
    # Single-colour anime anatomy: an almond OUTLINE ring whose interior is the
    # HOLE (= the sclera), a separate filled IRIS carrying three hole speculars
    # (upper orb, lower spark, lower-rim crescent), a thick lash with an outer
    # flick, a lower lid line and a crease. Holes never overlap: evenodd cancels.
    'eyes': {
        'calm': mir('<path fill-rule="evenodd" d="M42.4 60.6 C43.0 54.2 46.7 51.5 50.7 51.5 C54.9 51.5 57.8 54.1 58.4 58.8 C58.6 61.2 57.7 63.4 56.3 64.6 C53.2 67.1 46.2 67.1 43.9 64.2 C43.0 63.0 42.2 61.9 42.4 60.6 Z M44.1 60.4 C44.7 55.6 47.6 53.4 50.7 53.4 C54.0 53.4 56.3 55.5 56.8 58.7 C57.0 60.6 56.3 62.3 55.3 63.2 C53.0 65.0 47.2 65.0 45.4 62.8 C44.7 61.9 44.1 61.2 44.1 60.4 Z"/><path fill-rule="evenodd" d="M50.7 56.3 A3.6 3.9 0 1 0 50.7 64.1 A3.6 3.9 0 1 0 50.7 56.3 Z M48.5 57.6 A1.35 1.35 0 1 0 51.2 57.6 A1.35 1.35 0 1 0 48.5 57.6 M51.9 62.3 A0.8 0.8 0 1 0 53.5 62.3 A0.8 0.8 0 1 0 51.9 62.3 M47.9 62.9 A3.5 3.5 0 0 0 53.4 63.4 L52.7 61.6 A2.2 2.2 0 0 1 48.6 61.2 Z"/><path d="M40.1 58.8 C41.2 52.6 45.3 49.8 50.6 49.8 C55.7 49.8 58.9 53.0 59.5 59.4 L56.4 59.6 C55.8 55.1 53.3 52.7 50.6 52.7 C47.5 52.7 44.4 54.6 43.0 60.3"/><path d="M44.6 65.4 Q50.8 68.2 56.4 65.1 L55.9 63.9 Q50.9 66.7 45.1 64.2"/>'),
        'angry': mir('<path fill-rule="evenodd" d="M42.9 60.0 C44.6 54.4 48.2 52.4 53.2 53.7 C55.1 55.5 55.3 58.7 54.0 61.6 C48.6 65.5 44.5 64.0 42.9 60.0 Z M44.6 59.9 C46.0 55.6 48.8 54.0 52.6 55.0 C54.0 56.4 54.1 58.8 53.1 61.0 C49.0 63.9 45.8 62.7 44.6 59.9 Z"/><path fill-rule="evenodd" d="M50.6 56.9 A3.4 3.7 0 1 0 50.6 64.3 A3.4 3.7 0 1 0 50.6 56.9 Z M48.5 58.2 A1.3 1.3 0 1 0 51.1 58.2 A1.3 1.3 0 1 0 48.5 58.2 M52.0 61.9 A0.75 0.75 0 1 0 53.5 61.9 A0.75 0.75 0 1 0 52.0 61.9 Z"/><path d="M40.7 56.9 L55.6 50.4 L56.9 53.1 L42.0 59.6"/><path d="M44.8 64.4 Q51.1 67.5 57.1 64.1 L56.5 62.8 Q51.2 66.0 45.4 62.9"/>'),
        'sad': mir('<path fill-rule="evenodd" d="M42.6 60.8 C43.5 55.0 47.0 53.0 50.9 53.9 C54.3 54.9 56.6 58.0 57.2 61.9 C54.2 65.8 44.5 65.5 42.6 60.8 Z M44.2 60.5 C45.0 56.0 47.7 54.6 50.8 55.3 C53.5 56.1 55.2 58.4 55.7 61.2 C53.3 64.1 45.7 63.9 44.2 60.5 Z"/><path fill-rule="evenodd" d="M50.8 57.0 A3.4 3.7 0 1 0 50.8 64.4 A3.4 3.7 0 1 0 50.8 57.0 Z M48.8 58.3 A1.3 1.3 0 1 0 51.4 58.3 A1.3 1.3 0 1 0 48.8 58.3 M52.2 62.1 A0.75 0.75 0 1 0 53.7 62.1 A0.75 0.75 0 1 0 52.2 62.1 Z"/><path d="M40.3 59.3 C41.5 53.6 45.4 51.1 50.6 51.4 C55.2 51.8 58.0 54.6 58.5 60.0 L55.6 60.1 C55.0 55.9 52.7 53.9 50.3 53.7 C47.3 53.4 44.4 55.3 43.0 60.5"/><path d="M49.0 66.6 Q52.3 69.0 55.4 66.9 L54.6 65.3 Q52.2 66.8 49.9 65.1"/>'),
        'closed': mir('<path d="M40.3 59.5 L43.1 51.3 L45.3 57.0"/><path d="M43.1 62.5 Q50.3 53.3 57.5 61.3 L55.2 62.0 Q49.9 55.6 45.2 63.4"/><path d="M44.9 64.9 Q50.9 67.5 56.7 64.5 L56.2 63.2 Q51.1 66.0 45.4 63.5"/>'),
        'wide': mir('<path fill-rule="evenodd" d="M42.0 60.9 C42.6 54.4 46.5 51.6 50.8 51.6 C55.3 51.6 58.3 54.4 58.9 59.5 C59.1 62.1 58.0 64.6 56.6 65.9 C53.3 68.6 45.9 68.6 43.5 65.4 C42.6 64.2 41.8 62.4 42.0 60.9 Z M43.8 60.7 C44.4 55.8 47.5 53.6 50.8 53.6 C54.3 53.6 56.7 55.9 57.2 59.4 C57.4 61.4 56.5 63.3 55.4 64.3 C52.8 66.4 46.5 66.4 44.8 64.1 C44.1 63.2 43.8 61.9 43.8 60.7 Z"/><path fill-rule="evenodd" d="M50.8 56.0 A4.0 4.3 0 1 0 50.8 64.6 A4.0 4.3 0 1 0 50.8 56.0 Z M48.3 57.4 A1.6 1.6 0 1 0 51.5 57.4 A1.6 1.6 0 1 0 48.3 57.4 M52.2 62.8 A0.9 0.9 0 1 0 54.0 62.8 A0.9 0.9 0 1 0 52.2 62.8 M47.6 63.2 A3.9 3.9 0 0 0 53.9 63.8 L53.1 61.8 A2.5 2.5 0 0 1 48.4 61.4 Z"/><path d="M39.7 58.9 C40.8 52.1 45.0 49.1 50.5 49.1 C56.0 49.1 59.4 52.6 60.0 59.5 L56.7 59.7 C56.1 54.7 53.4 52.1 50.5 52.1 C47.2 52.1 44.1 54.2 42.7 60.4"/><path d="M44.1 65.9 Q50.8 69.2 56.8 65.7 L56.2 64.3 Q50.9 67.6 44.7 64.5"/>'),
    },
    # ---------------- mouth / expression ----------------
    'mouth': {
        'neutral': '<path d="M54.6 71.6 Q60 70.2 65.4 71.6 L65.2 73 Q60 71.8 54.8 73 Z"/>',
        'smile':   '<path d="M52.4 69.8 Q60 77 67.6 69.8 Q60 73.4 52.4 69.8 Z"/>',
        'frown':   '<path d="M53 74.6 Q60 68.8 67 74.6 Q60 72 53 74.6 Z"/>',
        'grim':    '<path fill-rule="evenodd" d="M49 69.6 H71 L68 77.6 H52 Z '
                   'M54 69.6 L55.6 73.6 H57.6 L56 69.6 Z M64 71.6 L65.6 75.6 H67.6 L66 71.6 Z"/>',
    },
    # ---------------- accessories: worn over the hair ----------------
    'extra': {
        'none':     '',
        # Hood: brim edge and a fold, both cut as holes so they stay one colour.
        'hood':     '<path fill-rule="evenodd" d="M24 62 Q24 16 60 16 Q96 16 96 62 '
                    'Q85 42 60 42 Q35 42 24 62 Z '
                    'M38 62 Q38 46 60 46 Q82 46 82 62 Q82 82 60 82 Q38 82 38 62 Z '
                    'M44 60 Q60 54 76 60 Q60 57 44 60 Z"/>',
        # Wizard hat: kinked cone, band, buckle (a hole) and a bent tip.
        'pointed':  '<path fill-rule="evenodd" d="M60 2 Q64 22 78 34 Q90 44 94 48 H26 '
                    'Q30 40 44 26 Q56 12 60 2 Z M57 18 L64 22 L57 26 Z"/>'
                    '<path d="M26 46 H94 L91 56 H29 Z"/>',
        # Helm: dome, visor slit (hole), rivets, nose guard.
        'helm':     '<path fill-rule="evenodd" d="M31 58 Q31 24 60 24 Q89 24 89 58 V72 H31 Z '
                    'M34 52 H86 V58 H34 Z M36 44 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 Z M80 44 a2 2 0 1 0 4 0 a2 2 0 1 0 -4 0 Z"/>' 
                    '<path d="M56 24 H64 V52 L60 58 L56 52 Z"/>',


        # Oni horns: ridged, sweeping out and up.
        'horns':    '<path fill-rule="evenodd" d="M36 36 Q20 30 15 10 Q30 17 39 29 Z '
                    'M33 28 Q25 24 21 15 Q30 20 36 26 Z"/>'
                    '<path fill-rule="evenodd" d="M84 36 Q100 30 105 10 Q90 17 81 29 Z '
                    'M87 28 Q95 24 99 15 Q90 20 84 26 Z"/>',
        # Bandit mask: eye slits cut clean through.
        'mask':     '<path fill-rule="evenodd" d="M30 50 Q60 40 90 50 Q88 64 78 66 '
                    'Q70 58 60 58 Q50 58 42 66 Q32 64 30 50 Z '
                    'M42 54 Q48 51 54 53 V60 Q48 60 42 58 Z '
                    'M78 54 Q72 51 66 53 V60 Q72 60 78 58 Z"/>',
        # Crown: points with gems punched out.
        'crown':    '<path fill-rule="evenodd" d="M34 46 L40 24 L48 36 L60 16 L72 36 L80 24 L86 46 Z '
                    'M44 34 A2 2 0 1 0 48 34 A2 2 0 1 0 44 34 Z '
                    'M58 28 A2.4 2.4 0 1 0 62.8 28 A2.4 2.4 0 1 0 58 28 Z '
                    'M72 34 A2 2 0 1 0 76 34 A2 2 0 1 0 72 34 Z"/>'
                    '<path d="M33 44 H87 L86 52 H34 Z"/>',
    },
}


def main():
    os.makedirs(OUT, exist_ok=True)
    n = 0
    for slot, shapes in PARTS.items():
        for name, inner in shapes.items():
            body = inner.strip()
            if not body:
                # An empty option (bald / none) still needs a file so the client can
                # reference it uniformly; transparent means "draw nothing".
                svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" '
                       'width="120" height="120"></svg>\n')
            else:
                svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" '
                       'width="120" height="120" fill="#000">' + body + '</svg>\n')
            with open(os.path.join(OUT, f'{slot}_{name}.svg'), 'w', encoding='utf-8') as f:
                f.write(svg)
            n += 1
    print(f'wrote {n} part files to {OUT}')
    for slot, shapes in PARTS.items():
        print(f'  {slot}: {", ".join(shapes)}')


if __name__ == '__main__':
    main()
