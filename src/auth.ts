export interface CurrentUser { id: number; account: string; avatarHash: string }
import { renderPlayerName } from "./name-font.ts";
let currentUser: CurrentUser | null = null;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "请求失败");
  return body;
}
function avatarUrl(user: CurrentUser): string { return `/api/users/${user.id}/avatar?v=${encodeURIComponent(user.avatarHash)}`; }
function showUser(user: CurrentUser): void {
  currentUser = user;
  const button = document.querySelector<HTMLButtonElement>("#account-button")!; button.hidden = false;
  document.querySelector<HTMLImageElement>("#account-avatar")!.src = avatarUrl(user);
  document.querySelector<HTMLElement>("#account-name")!.textContent = user.account;
  // 主菜单「欢迎回来，我的朋友！」下面那块空木板，原版就是写玩家名字的地方。
  renderPlayerName(document.querySelector<HTMLElement>("#menu-player")!, user.account);
  document.querySelector<HTMLImageElement>("#profile-avatar")!.src = avatarUrl(user);
  document.querySelector<HTMLElement>("#profile-account")!.textContent = user.account;
}
function status(message: string, error = false): void {
  const element = document.querySelector<HTMLElement>("#auth-status")!; element.textContent = message; element.classList.toggle("error", error);
}

function bind(): void {
  const auth = document.querySelector<HTMLDialogElement>("#auth-dialog")!;
  const login = document.querySelector<HTMLFormElement>("#login-form")!, register = document.querySelector<HTMLFormElement>("#register-form")!;
  const loginTab = document.querySelector<HTMLButtonElement>("#show-login")!, registerTab = document.querySelector<HTMLButtonElement>("#show-register")!;
  const tab = (showRegister: boolean) => { login.hidden = showRegister; register.hidden = !showRegister; loginTab.classList.toggle("active", !showRegister); registerTab.classList.toggle("active", showRegister); status(showRegister ? "邀请码、账号、密码和头像都必须填写。" : "请使用你的账号登录。"); };
  loginTab.addEventListener("click", () => tab(false)); registerTab.addEventListener("click", () => tab(true));

  let source: HTMLImageElement | null = null, avatar = "";
  const canvas = document.querySelector<HTMLCanvasElement>("#avatar-canvas")!, zoom = document.querySelector<HTMLInputElement>("#avatar-zoom")!, editor = document.querySelector<HTMLElement>("#avatar-editor")!;
  const render = () => { if (!source) return; const ctx = canvas.getContext("2d")!, scale = Math.max(128 / source.width, 128 / source.height) * Number(zoom.value), width = source.width * scale, height = source.height * scale; ctx.clearRect(0, 0, 128, 128); ctx.drawImage(source, (128 - width) / 2, (128 - height) / 2, width, height); avatar = canvas.toDataURL("image/webp", .82); };
  document.querySelector<HTMLInputElement>("#avatar-file")!.addEventListener("change", (event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) { source = null; avatar = ""; editor.hidden = true; status("请选择5MB以内的PNG、JPEG或WebP图片。", true); return; }
    const url = URL.createObjectURL(file), image = new Image();
    image.onload = () => { source = image; zoom.value = "1"; editor.hidden = false; render(); URL.revokeObjectURL(url); };
    image.onerror = () => { URL.revokeObjectURL(url); status("头像图片无法读取。", true); }; image.src = url;
  });
  zoom.addEventListener("input", render);
  login.addEventListener("submit", async (event) => { event.preventDefault(); status("正在登录…"); try { const result = await api<{user:CurrentUser}>("/api/auth/login", { method:"POST", body:JSON.stringify({ account:(document.querySelector<HTMLInputElement>("#login-account")!).value, password:(document.querySelector<HTMLInputElement>("#login-password")!).value }) }); showUser(result.user); auth.close(); } catch (error) { status((error as Error).message, true); } });
  register.addEventListener("submit", async (event) => { event.preventDefault(); if (!avatar) { status("请先上传并裁剪头像。", true); return; } status("正在安全创建账号…"); try { const result = await api<{user:CurrentUser}>("/api/auth/register", { method:"POST", body:JSON.stringify({ inviteCode:(document.querySelector<HTMLInputElement>("#register-invite")!).value, account:(document.querySelector<HTMLInputElement>("#register-account")!).value, password:(document.querySelector<HTMLInputElement>("#register-password")!).value, avatar }) }); showUser(result.user); auth.close(); } catch (error) { status((error as Error).message, true); } });
  const account = document.querySelector<HTMLDialogElement>("#account-dialog")!;
  document.querySelector<HTMLButtonElement>("#account-button")!.addEventListener("click", () => account.showModal());
  document.querySelector<HTMLButtonElement>("#close-account")!.addEventListener("click", () => account.close());
  document.querySelector<HTMLButtonElement>("#logout-button")!.addEventListener("click", async () => { await api("/api/auth/logout", { method:"POST", body:"{}" }); sessionStorage.clear(); location.reload(); });
}

export async function requireAuthentication(): Promise<CurrentUser> {
  bind();
  try { const result = await api<{user:CurrentUser}>("/api/auth/me"); showUser(result.user); return result.user; }
  catch {
    const dialog = document.querySelector<HTMLDialogElement>("#auth-dialog")!; dialog.showModal();
    return new Promise((resolve) => { const timer = window.setInterval(() => { if (currentUser) { window.clearInterval(timer); resolve(currentUser); } }, 100); });
  }
}
