// 安卓壳（FloatShell）与网页之间的推送桥：
// 个人云的 Realtime 地址和 service_role 只存在 WebView IndexedDB 里，
// 壳的前台服务读不到。页面把连接参数交给 window.AndroidShell.configurePush，
// 原生 PushService 再直连用户自己的 Supabase，而不是站点联机库。

import { isCloudBackupConfigured, loadCloudBackupConfig } from "./cloud-backup/config";
import { loadPersonalPushCloudState } from "./personal-push-cloud";

export const SHELL_PUSH_OWNER_ID = "owner";

export type AndroidShellBridge = {
  getVersion?: () => string;
  openAppSettings?: () => void;
  requestIgnoreBatteryOptimization?: () => void;
  configurePush?: (json: string) => void;
};

export type ShellPushNativeConfig = {
  supabaseUrl: string;
  realtimeKey: string;
  userId: string;
};

export const SHELL_PUSH_SYNC_EVENT = "floatshell-ready";
export const CLOUD_CONFIG_CHANGED_EVENT = "ai-phone-cloud-config-changed";

export function getAndroidShell(): AndroidShellBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { AndroidShell?: AndroidShellBridge }).AndroidShell;
  return bridge && typeof bridge === "object" ? bridge : null;
}

/** UA 可能被部分 ROM 改掉；有原生桥就算在壳里。 */
export function hasAndroidShellBridge(): boolean {
  return getAndroidShell() !== null;
}

/** 当前 APK 是否带个人云长连接桥（1.1.0+）。旧壳没有这个方法。 */
export function isShellPushBridgeReady(): boolean {
  const shell = getAndroidShell();
  if (!shell) return false;
  try {
    return typeof shell.configurePush === "function" || "configurePush" in shell;
  } catch {
    return true;
  }
}

export function buildShellPushNativeConfig(): ShellPushNativeConfig | null {
  const state = loadPersonalPushCloudState();
  const backup = loadCloudBackupConfig();
  if (!state || !isCloudBackupConfigured(backup)) return null;
  return {
    supabaseUrl: state.url,
    realtimeKey: backup.key.trim(),
    userId: SHELL_PUSH_OWNER_ID,
  };
}

function invokeConfigurePush(json: string): boolean {
  const shell = getAndroidShell();
  if (!shell) return false;
  try {
    const configure = shell.configurePush;
    if (typeof configure === "function") {
      configure.call(shell, json);
      return true;
    }
    // 部分 WebView 上 JavascriptInterface 方法的 typeof 不是 function，仍可直接调用。
    (shell as { configurePush: (payload: string) => void }).configurePush(json);
    return true;
  } catch {
    return false;
  }
}

/** 把个人云 Realtime 参数交给原生壳；旧 APK 或缺配置时静默跳过。 */
export function syncShellPushNativeConfig(): boolean {
  const config = buildShellPushNativeConfig();
  if (!config) return false;
  return invokeConfigurePush(JSON.stringify(config));
}

let shellPushSyncInstalled = false;

/** 壳内反复尝试下发配置：水合完成、页面可见、原生 onPageFinished、云配置刚写入。 */
export function installShellPushNativeSync(): void {
  if (typeof window === "undefined" || shellPushSyncInstalled) return;
  const start = () => {
    if (shellPushSyncInstalled) return;
    if (!hasAndroidShellBridge() && !navigator.userAgent.includes("FloatShell/")) return;
    shellPushSyncInstalled = true;
    const tick = () => {
      syncShellPushNativeConfig();
    };
    tick();
    window.addEventListener(SHELL_PUSH_SYNC_EVENT, tick);
    window.addEventListener(CLOUD_CONFIG_CHANGED_EVENT, tick);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
    window.addEventListener("focus", tick);
    window.setInterval(tick, 15_000);
  };
  start();
  if (!shellPushSyncInstalled) {
    window.addEventListener(SHELL_PUSH_SYNC_EVENT, start);
    window.setTimeout(start, 1500);
    window.setTimeout(start, 5000);
  }
}
