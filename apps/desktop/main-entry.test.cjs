"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

test("Desktop recognizes the Electron argv entry when Electron does not set require.main", () => {
  const main = loadDesktopMain();
  const filename = path.join(__dirname, "main.cjs");
  assert.equal(main.isDesktopEntryModule({ mainModule: {}, moduleRef: {}, argv: ["Electron", filename], filename }), true);
  assert.equal(main.isDesktopEntryModule({ mainModule: {}, moduleRef: {}, argv: ["Electron", __dirname], filename }), true);
  assert.equal(main.isDesktopEntryModule({ mainModule: {}, moduleRef: {}, argv: ["Electron", "other.cjs"], filename }), false);
  const shared = {};
  assert.equal(main.isDesktopEntryModule({ mainModule: shared, moduleRef: shared, argv: [] }), true);
});

function loadDesktopMain() {
  const mainPath = require.resolve("./main.cjs");
  const originalLoad = Module._load;
  Module._load = function loadElectronMock(request, parent, isMain) {
    if (request === "electron") return { app: {}, BrowserWindow: class {}, ipcMain: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[mainPath];
    return require(mainPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[mainPath];
  }
}
