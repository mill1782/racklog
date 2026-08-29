"""Generate the PWA icons: a bumper-plate-red square with a white barbell.

Raw PNG via zlib + struct so there is no image dependency to install; the icons
are committed, so this only ever runs again if the mark changes.
"""
import zlib, struct, os

BG = (0xC8, 0x37, 0x2A)   # --accent, the push red
FG = (0xFF, 0xFF, 0xFF)

# normalized boxes: (x0, y0, x1, y1). Kept inside the middle 80% so a maskable
# icon can crop to a circle without clipping the bar.
BARBELL = [
    (0.14, 0.470, 0.86, 0.530),   # bar
    (0.24, 0.330, 0.315, 0.670),  # inner plate, left
    (0.685, 0.330, 0.76, 0.670),  # inner plate, right
    (0.155, 0.385, 0.205, 0.615), # outer plate, left
    (0.795, 0.385, 0.845, 0.615), # outer plate, right
]

def render(size):
    rows = []
    boxes = [(x0 * size, y0 * size, x1 * size, y1 * size) for x0, y0, x1, y1 in BARBELL]
    for y in range(size):
        row = bytearray(b"\x00")            # filter byte: none
        cy = y + 0.5
        for x in range(size):
            cx = x + 0.5
            on = any(x0 <= cx <= x1 and y0 <= cy <= y1 for x0, y0, x1, y1 in boxes)
            row += bytes(FG if on else BG)
        rows.append(bytes(row))
    return b"".join(rows)

def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

def write_png(path, size):
    hdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)   # 8-bit truecolour
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", hdr) +
           chunk(b"IDAT", zlib.compress(render(size), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return len(png)

out = r"C:\Users\Mark Miller\Documents\source\workout-tracker\worker"
os.makedirs(out, exist_ok=True)
for s in (192, 512):
    p = os.path.join(out, "icon-%d.png" % s)
    print("%s  %d bytes" % (p, write_png(p, s)))
