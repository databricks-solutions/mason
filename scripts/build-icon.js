// Generate a macOS-style icon (white squircle + Databricks emblem) and an .icns bundle.
// Usage: node scripts/build-icon.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const SRC_EMBLEM = path.join(ROOT, "icons", "Databricks-Emblem.png");
const BUILD = path.join(ROOT, "build");
const ICONSET = path.join(BUILD, "icon.iconset");
const ICNS = path.join(BUILD, "icon.icns");
const SQUARE_PNG = path.join(BUILD, "icon_square.png");

const CANVAS = 1024;
// Apple HIG: macOS icon corner radius is ~22.37% of icon width (squircle approx).
const RADIUS = Math.round(CANVAS * 0.2237);
// Emblem fills ~76% of the canvas (centered) — leaves balanced padding.
const EMBLEM_SIZE = Math.round(CANVAS * 0.76);

function squircleSvg(w, h, r) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
       <rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="#ffffff"/>
     </svg>`,
  );
}

async function main() {
  if (!fs.existsSync(SRC_EMBLEM)) {
    console.error(`[build-icon] missing source: ${SRC_EMBLEM}`);
    process.exit(1);
  }

  // Trim transparent padding from the source emblem so our sizing is consistent,
  // then resize it to EMBLEM_SIZE preserving aspect ratio inside that box.
  const emblem = await sharp(SRC_EMBLEM)
    .trim()
    .resize(EMBLEM_SIZE, EMBLEM_SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Build the 1024x1024 white squircle base, then composite emblem centered.
  const base = await sharp({
    create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: squircleSvg(CANVAS, CANVAS, RADIUS), top: 0, left: 0 },
      { input: emblem, gravity: "center" },
    ])
    .png()
    .toBuffer();

  fs.writeFileSync(SQUARE_PNG, base);
  console.log(`[build-icon] wrote ${path.relative(ROOT, SQUARE_PNG)}`);

  // Apple iconset sizes.
  const sizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];

  fs.rmSync(ICONSET, { recursive: true, force: true });
  fs.mkdirSync(ICONSET, { recursive: true });
  for (const [px, name] of sizes) {
    await sharp(base).resize(px, px).png().toFile(path.join(ICONSET, name));
  }
  console.log(`[build-icon] wrote iconset (${sizes.length} sizes)`);

  execSync(`iconutil -c icns -o "${ICNS}" "${ICONSET}"`);
  console.log(`[build-icon] wrote ${path.relative(ROOT, ICNS)}`);
}

main().catch((err) => {
  console.error("[build-icon] failed:", err);
  process.exit(1);
});
