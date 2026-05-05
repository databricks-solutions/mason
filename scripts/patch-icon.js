const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const electronDir = path.join(__dirname, "..", "node_modules", "electron");
const distDir = path.join(electronDir, "dist");
const electronApp = path.join(distDir, "Electron.app");
const masonApp = path.join(distDir, "Mason.app");
const pathFile = path.join(electronDir, "path.txt");
const srcIcon = path.join(__dirname, "..", "build", "icon.icns");

// Determine the actual .app path (might already be renamed)
let appDir;
if (fs.existsSync(masonApp) && !fs.lstatSync(masonApp).isSymbolicLink()) {
  appDir = masonApp;
} else if (fs.existsSync(electronApp) && !fs.lstatSync(electronApp).isSymbolicLink()) {
  appDir = electronApp;
} else {
  console.log("[patch] No Electron.app or Mason.app found, skipping.");
  process.exit(0);
}

const resources = path.join(appDir, "Contents", "Resources");
const plist = path.join(appDir, "Contents", "Info.plist");

// --- Patch icon ---
if (fs.existsSync(srcIcon)) {
  fs.copyFileSync(srcIcon, path.join(resources, "app.icns"));
  fs.copyFileSync(srcIcon, path.join(resources, "electron.icns"));
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile app.icns" "${plist}"`);
  } catch (_) {}
  console.log("[patch] Icon replaced.");
}

// --- Patch plist name ---
for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :${key} Mason" "${plist}"`);
  } catch (_) {}
}

// --- Rename executable ---
const oldExe = path.join(appDir, "Contents", "MacOS", "Electron");
const newExe = path.join(appDir, "Contents", "MacOS", "Mason");
if (fs.existsSync(oldExe) && !fs.existsSync(newExe)) {
  fs.renameSync(oldExe, newExe);
  try {
    execSync(`/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Mason" "${plist}"`);
  } catch (_) {}
  console.log("[patch] Executable renamed: Electron -> Mason");
}

// --- Rename .app bundle ---
if (appDir === electronApp) {
  // Remove old symlink if exists
  if (fs.existsSync(masonApp)) {
    try { fs.unlinkSync(masonApp); } catch (_) {}
  }
  fs.renameSync(electronApp, masonApp);
  // Create symlink so electron launcher still works via old path
  fs.symlinkSync("Mason.app", electronApp);
  console.log("[patch] Bundle renamed: Electron.app -> Mason.app");
}

// Update path.txt
fs.writeFileSync(pathFile, "Mason.app/Contents/MacOS/Mason");

// Touch to bust icon cache
try { execSync(`touch "${masonApp}"`); } catch (_) {}

console.log("[patch] Done.");
