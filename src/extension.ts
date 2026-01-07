import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as process from "process";
import { exec } from "child_process";
import assert = require("assert");

const JJUI_TOGGLE_COMMAND = "jjui-vscode.toggle";
const JJUI_CONTEXT_KEY = "jjuiFocus";

let jjuiTerminal: vscode.Terminal | undefined;
let globalConfig: JJUIConfig;
let globalConfigJSON: string;

/* --- Config --- */

type PanelBehavior = "keep" | "hide" | "hideRestore";

interface PanelOptions {
  sidebar: PanelBehavior;
  panel: PanelBehavior;
  secondarySidebar: PanelBehavior;
}

interface JJUIConfig {
  jjuiPath: string;
  autoMaximizeWindow: boolean;
  panels: PanelOptions;
}

function loadConfig(): JJUIConfig {
  const config = vscode.workspace.getConfiguration("jjui-vscode");

  function getPanelBehavior(panelName: string): PanelBehavior {
    const defaultValue = panelName === "secondarySidebar" ? "hide" : "keep";
    return config.get<PanelBehavior>(`panels.${panelName}`, defaultValue);
  }

  return {
    jjuiPath: config.get<string>("jjuiPath", ""),
    autoMaximizeWindow: config.get<boolean>("autoMaximizeWindow", false),
    panels: {
      sidebar: getPanelBehavior("sidebar"),
      panel: getPanelBehavior("panel"),
      secondarySidebar: getPanelBehavior("secondarySidebar"),
    },
  };
}

async function reloadIfConfigChange() {
  const currentConfig = loadConfig();
  if (JSON.stringify(currentConfig) !== globalConfigJSON) {
    await loadExtension();
  }
}

async function loadExtension() {
  globalConfig = loadConfig();
  globalConfigJSON = JSON.stringify(globalConfig);

  if (globalConfig.jjuiPath) {
    globalConfig.jjuiPath = expandPath(globalConfig.jjuiPath);
  } else {
    try {
      globalConfig.jjuiPath = await findExecutableOnPath("jjui");
    } catch (error) {
      vscode.window.showErrorMessage(
        "jjui not found on PATH. Please install it or set jjuiPath.",
      );
    }
  }
}

/* --- Events --- */

export async function activate(context: vscode.ExtensionContext) {
  await loadExtension();

  async function toggleJJUI() {
    if (jjuiTerminal) {
      if (windowFocused()) {
        closeWindow();
        onHide();
      } else {
        focusWindow();
        onShown();
      }
    } else {
      await createWindow();
      onShown();
    }
  }

  const updateFocusContext = () => {
    vscode.commands.executeCommand(
      "setContext",
      JJUI_CONTEXT_KEY,
      windowFocused(),
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(JJUI_TOGGLE_COMMAND, toggleJJUI),
    vscode.window.onDidChangeActiveTextEditor(updateFocusContext),
    vscode.window.onDidChangeActiveTerminal(updateFocusContext),
  );
}

/* --- Window Management --- */

async function createWindow() {
  await reloadIfConfigChange();
  const workspaceFolder = getWorkspaceFolder();
  const isWin = process.platform === "win32";

  jjuiTerminal = vscode.window.createTerminal({
    name: "jjui",
    cwd: workspaceFolder,
    location: vscode.TerminalLocation.Editor,
    shellPath: isWin ? "powershell.exe" : "/bin/bash",
    shellArgs: isWin
      ? ["-Command", `${globalConfig.jjuiPath}; exit`]
      : ["-c", `${globalConfig.jjuiPath} && exit`],
  });

  // Attempt to focus immediately
  jjuiTerminal.show(false);

  let focusAttempts = 0;
  const pollFocus = () => {
    if (vscode.window.activeTerminal === jjuiTerminal) {
      // Focus achieved!
      return;
    }
    if (focusAttempts < 10) {
      // Max 10 attempts (1 second total)
      focusAttempts++;
      vscode.commands.executeCommand("workbench.action.terminal.focus");
      setTimeout(pollFocus, 100);
    }
  };

  pollFocus();

  vscode.window.onDidCloseTerminal((t) => {
    if (t === jjuiTerminal) {
      jjuiTerminal = undefined;
      onHide();
    }
  });
}

function windowFocused(): boolean {
  return (
    vscode.window.activeTextEditor === undefined &&
    vscode.window.activeTerminal === jjuiTerminal
  );
}

function focusWindow() {
  assert(jjuiTerminal, "Terminal undefined!");
  jjuiTerminal.show(false);
}

function closeWindow() {
  const openTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).length;
  if (openTabs === 1 && jjuiTerminal) {
    jjuiTerminal.dispose();
  } else {
    vscode.commands.executeCommand(
      "workbench.action.openPreviousRecentlyUsedEditorInGroup",
    );
  }
}

/* --- UI Logic (Panels) --- */

function onShown() {
  const shouldKeep = (behavior: PanelBehavior) => behavior === "keep";
  const shouldHide = (behavior: PanelBehavior) =>
    behavior === "hide" || behavior === "hideRestore";

  if (globalConfig.autoMaximizeWindow) {
    vscode.commands.executeCommand(
      "workbench.action.maximizeEditorHideSidebar",
    );
    if (shouldKeep(globalConfig.panels.sidebar)) {
      vscode.commands.executeCommand(
        "workbench.action.toggleSidebarVisibility",
      );
    }
  } else {
    if (shouldHide(globalConfig.panels.sidebar))
      vscode.commands.executeCommand("workbench.action.closeSidebar");
    if (shouldHide(globalConfig.panels.secondarySidebar))
      vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  }

  if (shouldHide(globalConfig.panels.panel))
    vscode.commands.executeCommand("workbench.action.closePanel");
}

function onHide() {
  const shouldRestore = (behavior: PanelBehavior) => behavior === "hideRestore";
  // if (shouldRestore(globalConfig.panels.sidebar)) vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility");
  if (shouldRestore(globalConfig.panels.secondarySidebar))
    vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  if (shouldRestore(globalConfig.panels.panel))
    vscode.commands.executeCommand("workbench.action.togglePanel");

  if (globalConfig.autoMaximizeWindow) {
    vscode.commands.executeCommand("workbench.action.evenEditorWidths");
  }

  setTimeout(() => {
    vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
  }, 200);
}

/* --- Utils --- */

function findExecutableOnPath(executable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const command =
      process.platform === "win32"
        ? `where ${executable}`
        : `which ${executable}`;
    exec(command, (error, stdout) => {
      if (error) reject(new Error(`${executable} not found`));
      else resolve(stdout.split("\r\n")[0].split("\n")[0].trim());
    });
  });
}

function expandPath(pth: string): string {
  pth = pth.replace(/^~(?=$|\/|\\)/, os.homedir());
  return pth
    .replace(/%([^%]+)%/g, (_, n) => process.env[n] || "")
    .replace(/\$([A-Za-z0-9_]+)/g, (_, n) => process.env[n] || "");
}

function getWorkspaceFolder(): string {
  // 1. Try to get URI from a standard text editor OR a Jupyter Notebook editor
  const activeEditorUri =
    vscode.window.activeTextEditor?.document.uri ||
    vscode.window.activeNotebookEditor?.notebook.uri;

  if (activeEditorUri) {
    const folder = vscode.workspace.getWorkspaceFolder(activeEditorUri);
    if (folder) return folder.uri.fsPath;
  }

  // 2. Fallback: Search all open workspace folders for the first one containing .jj
  const folders = vscode.workspace.workspaceFolders;
  if (folders) {
    for (const folder of folders) {
      if (fs.existsSync(path.join(folder.uri.fsPath, ".jj"))) {
        return folder.uri.fsPath;
      }
    }
    return folders[0].uri.fsPath;
  }

  return os.homedir();
}
