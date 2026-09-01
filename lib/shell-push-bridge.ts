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

export function getAndroidShell(): AndroidShellBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = (window as unknown as { AndroidShell?: AndroidShellBridge }).AndroidShell;
  return bridge && typeof bridge === "object" ? bridge : null;
}

/** 当前 APK 是否带个人云长连接桥（1.1.0+）。旧壳没有这个方法。 */
export function isShellPushBridgeReady(): boolean {
  return typeof getAndroidShell()?.configurePush === "function";
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

/** 把个人云 Realtime 参数交给原生壳；旧 APK 或缺配置时静默跳过。 */
export function syncShellPushNativeConfig(): boolean {
  const configure = getAndroidShell()?.configurePush;
  if (typeof configure !== "function") return false;
  const config = buildShellPushNativeConfig();
  if (!config) return false;
  configure(JSON.stringify(config));
  return true;
}
