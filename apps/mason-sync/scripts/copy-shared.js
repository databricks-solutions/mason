#!/usr/bin/env node
// Prebuild step: copy the desktop's dependency-free chat helpers into this
// app so the server's turn engine runs the exact same request-building code
// as Mason desktop and the model sweep. Single source of truth lives at
// ../../src/chat-shared.ts — never edit the copy.
"use strict";
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "..", "..", "src", "chat-shared.ts");
const dest = path.join(__dirname, "..", "shared", "chat-shared.ts");

// In the Databricks Apps build environment only the app folder exists — the
// Mason repo source isn't there, but the previously-copied file uploads with
// the bundle. Skip the copy when the source is absent and a copy exists.
if (!fs.existsSync(src)) {
  if (fs.existsSync(dest)) {
    console.log("[copy-shared] repo source unavailable; using bundled shared/chat-shared.ts");
    process.exit(0);
  }
  console.error("[copy-shared] neither repo source nor bundled copy found");
  process.exit(1);
}

const banner =
  "// AUTO-COPIED from src/chat-shared.ts by scripts/copy-shared.js — do not edit.\n";
const body = fs.readFileSync(src, "utf-8");
fs.writeFileSync(dest, banner + body);
console.log(`[copy-shared] ${path.relative(process.cwd(), src)} -> shared/chat-shared.ts`);
