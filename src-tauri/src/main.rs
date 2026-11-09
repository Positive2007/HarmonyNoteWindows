// 发布版使用 Windows GUI 子系统：双击快捷方式不再弹出黑色命令行窗口。
// 调试版仍保留控制台，方便看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Bytes;
use axum::extract::{Path as AxPath, Request, State};
use axum::http::{header, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use tauri::Manager;
use tokio::sync::watch;

pub const PORT: u16 = 8787;

/// 端口是否成功监听：被别的进程占用时前端要能看出来
static BOUND: AtomicBool = AtomicBool::new(false);

/// 应用全局状态：笔记根目录
pub struct AppState {
    pub notes_dir: Mutex<PathBuf>,
}

#[derive(Clone)]
struct AppStateShared(Arc<AppState>);

// ---------------- 文件名与墓碑 ----------------

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.contains("..")
        && !name.contains('/')
        && !name.contains('\\')
}

fn tomb_path(dir: &Path) -> PathBuf {
    dir.join("_tombstones.json")
}

/// 墓碑：记录被“彻底删除”的笔记 id，供鸿蒙端拉取后删本地副本
fn read_tombs(dir: &Path) -> Vec<String> {
    let txt = match std::fs::read_to_string(tomb_path(dir)) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&txt) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    v.get("ids")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn write_tombs(dir: &Path, ids: &[String]) {
    let v = serde_json::json!({ "ids": ids });
    let _ = std::fs::write(tomb_path(dir), v.to_string());
}

fn add_tomb(dir: &Path, id: &str) {
    let mut ids = read_tombs(dir);
    if !ids.iter().any(|x| x == id) {
        ids.push(id.to_string());
    }
    // 只保留最近 500 条，避免无限增长
    if ids.len() > 500 {
        let n = ids.len() - 500;
        ids.drain(0..n);
    }
    write_tombs(dir, &ids);
}

fn remove_tomb(dir: &Path, id: &str) {
    let mut ids = read_tombs(dir);
    let before = ids.len();
    ids.retain(|x| x != id);
    if ids.len() != before {
        write_tombs(dir, &ids);
    }
}

// ---------------- HTTP handlers ----------------

async fn put_file(
    State(st): State<AppStateShared>,
    AxPath(name): AxPath<String>,
    body: Bytes,
) -> Response {
    if !safe_name(&name) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let dir = st.0.notes_dir.lock().unwrap().clone();
    if std::fs::create_dir_all(&dir).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // 版本守卫：手机上可能残留旧副本（例如离线期间电脑已改过），
    // 这类「版本号更低」的写入一律拒绝，否则电脑端刚编辑的内容会被旧数据还原。
    if name.ends_with(".json") {
        let old_path = dir.join(&name);
        if let Ok(old_bytes) = std::fs::read(&old_path) {
            if let (Ok(old), Ok(new)) = (
                serde_json::from_slice::<serde_json::Value>(&old_bytes),
                serde_json::from_slice::<serde_json::Value>(&body),
            ) {
                let ov = old.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
                let nv = new.get("version").and_then(|v| v.as_i64()).unwrap_or(0);
                if nv < ov {
                    // 409 = 电脑端已有更新版本，本次写入作废
                    return (
                        StatusCode::CONFLICT,
                        axum::Json(serde_json::json!({
                            "error": "stale",
                            "localVersion": ov,
                            "incomingVersion": nv
                        })),
                    )
                        .into_response();
                }
            }
        }
    }

    // 先写临时文件再 rename，避免对端读到半个文件
    let tmp = dir.join(format!(".{}.part", name));
    if std::fs::write(&tmp, &body).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if std::fs::rename(&tmp, dir.join(&name)).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    // 收到活的笔记 JSON，说明该 id 重新存在，清掉对应墓碑
    if let Some(stem) = name.strip_suffix(".json") {
        remove_tomb(&dir, stem);
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn get_file(State(st): State<AppStateShared>, AxPath(name): AxPath<String>) -> Response {
    if !safe_name(&name) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let dir = st.0.notes_dir.lock().unwrap().clone();
    match std::fs::read(dir.join(&name)) {
        Ok(bytes) => bytes.into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// 彻底删除：删 .json 与其配套 .ink，并写入墓碑
async fn delete_file(State(st): State<AppStateShared>, AxPath(name): AxPath<String>) -> Response {
    if !safe_name(&name) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let dir = st.0.notes_dir.lock().unwrap().clone();
    let stem = name
        .rsplit_once('.')
        .map(|(a, _)| a.to_string())
        .unwrap_or_else(|| name.clone());
    let _ = std::fs::remove_file(dir.join(&name));
    let _ = std::fs::remove_file(dir.join(format!("{}.ink", stem)));
    add_tomb(&dir, &stem);
    StatusCode::NO_CONTENT.into_response()
}

async fn get_tombstones(State(st): State<AppStateShared>) -> Response {
    let dir = st.0.notes_dir.lock().unwrap().clone();
    let ids = read_tombs(&dir);
    axum::Json(serde_json::json!({ "ids": ids })).into_response()
}

/// 笔记文件清单：手机端据此做「拉取」方向的增量同步。
/// 除文件名与时间外，还带上 version/deleted/title，
/// 让手机端不下载正文就能判断哪条更新，避免每次同步全量传输。
async fn list_files(State(st): State<AppStateShared>) -> Response {
    let dir = st.0.notes_dir.lock().unwrap().clone();
    // 手机端每次同步都会先调本接口，借此记录「上次连接时间」供界面显示
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let _ = std::fs::write(dir.join("_last_pull"), now_ms.to_string());

    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p
                .file_name()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || name.starts_with('_') || name.starts_with('.') {
                continue;
            }
            let mtime = e
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            let mut version = 0i64;
            let mut deleted = false;
            let mut title = String::new();
            let mut ntype = 0i64;
            let mut updated_at = 0i64;
            if name.ends_with(".json") {
                if let Ok(bytes) = std::fs::read(&p) {
                    if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        version = v.get("version").and_then(|x| x.as_i64()).unwrap_or(0);
                        deleted = v.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false);
                        title = v
                            .get("title")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        ntype = v.get("type").and_then(|x| x.as_i64()).unwrap_or(0);
                        updated_at = v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0);
                    }
                }
            }

            files.push(serde_json::json!({
                "name": name,
                "mtime": mtime,
                "version": version,
                "deleted": deleted,
                "title": title,
                "type": ntype,
                "updatedAt": updated_at
            }));
        }
    }
    axum::Json(serde_json::json!({ "files": files })).into_response()
}

async fn ping() -> &'static str {
    "harmonynote"
}

// ---------------- CORS ----------------

fn add_cors(res: &mut Response) {
    let h = res.headers_mut();
    h.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,PUT,DELETE,OPTIONS"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("*"),
    );
    h.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("86400"),
    );
}

/// Tauri 的 WebView 源是 http://tauri.localhost，访问 127.0.0.1:8787 属跨域。
/// 没有这层中间件，前端 fetch 会被浏览器拦掉——表现就是“列表空的、点开也是空白”。
async fn cors_mw(req: Request, next: Next) -> Response {
    if *req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_cors(&mut res);
        return res;
    }
    let mut res = next.run(req).await;
    add_cors(&mut res);
    res
}

// ---------------- 网络信息 ----------------

fn local_ipv4() -> Option<Ipv4Addr> {
    // UDP connect 只做路由选路，不实际发包
    for target in [
        "8.8.8.8:80",
        "114.114.114.114:80",
        "223.5.5.5:80",
        "192.168.1.1:80",
        "10.255.255.255:1",
    ] {
        if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(std::net::SocketAddr::V4(a)) = sock.local_addr() {
                    let ip = *a.ip();
                    if !ip.is_loopback() && !ip.is_unspecified() {
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

pub fn start_file_server(
    notes_dir: PathBuf,
    port: u16,
) -> (watch::Receiver<bool>, std::thread::JoinHandle<()>) {
    let (tx, rx) = watch::channel(false);
    let state = AppStateShared(Arc::new(AppState {
        notes_dir: Mutex::new(notes_dir.clone()),
    }));

    let handle = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async move {
            let app = Router::new()
                .route("/api/ping", get(ping))
                .route("/api/tombstones", get(get_tombstones))
                .route("/api/notes", get(list_files))
                .route(
                    "/api/files/:name",
                    get(get_file).put(put_file).delete(delete_file),
                )
                .with_state(state)
                .layer(middleware::from_fn(cors_mw));
            let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("文件服务端口 {} 绑定失败: {}", port, e);
                    return;
                }
            };
            let _ = tx.send(true);
            BOUND.store(true, Ordering::SeqCst);
            if let Err(e) = axum::serve(listener, app).await {
                eprintln!("文件服务退出: {}", e);
            }
        });
    });
    (rx, handle)
}

/// mDNS 广播，让鸿蒙端自动发现本机
pub fn advertise(port: u16) -> Option<ServiceDaemon> {
    let v4: Ipv4Addr = local_ipv4()?;
    let ip: std::net::IpAddr = v4.into(); // mdns-sd 0.11 要求 IpAddr
    let daemon = ServiceDaemon::new().ok()?;
    let props: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    // 把 IP 编进服务名（192.168.1.8 → harmonynote-192-168-1-8）
    // 手机端若解析不到 host 的 A 记录，可以直接从服务名里取 IP 兜底
    let instance = format!("harmonynote-{}", v4.to_string().replace('.', "-"));
    let service_type = "_harmonynote._tcp.local.";
    let host = format!("harmonynote-{}.local.", uuid::Uuid::new_v4().simple());
    let info = ServiceInfo::new(service_type, &instance, &host, ip, port, Some(props)).ok()?;
    if let Err(e) = daemon.register(info) {
        eprintln!("mDNS 注册失败: {}", e);
        return None;
    }
    Some(daemon)
}

// ---------------- Tauri commands ----------------

#[tauri::command]
fn notes_dir(app: tauri::AppHandle) -> String {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("notes");
    std::fs::create_dir_all(&dir).ok();
    dir.to_string_lossy().to_string()
}

#[tauri::command]
fn open_notes_dir(dir: String) {
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .ok();
    #[cfg(not(target_os = "windows"))]
    {
        let _ = dir;
    }
}

/// 扫描笔记目录，返回全部笔记（含回收站里的软删除项）
#[tauri::command]
fn list_notes(app: tauri::AppHandle) -> Vec<serde_json::Value> {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("notes");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let name = p.file_name().and_then(|x| x.to_str()).unwrap_or("");
            if name.starts_with('_') || name.starts_with('.') {
                continue; // 跳过墓碑与临时文件
            }
            if p.extension().map(|x| x == "json").unwrap_or(false) {
                if let Ok(text) = std::fs::read_to_string(&p) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

/// 供界面显示本机地址与「手机上次连入时间」
#[tauri::command]
fn server_info(app: tauri::AppHandle) -> serde_json::Value {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("notes");
    let last_pull = std::fs::read_to_string(dir.join("_last_pull"))
        .ok()
        .and_then(|s| s.trim().parse::<u64>().ok())
        .unwrap_or(0);
    serde_json::json!({
        "ip": local_ipv4().map(|x| x.to_string()).unwrap_or_default(),
        "port": PORT,
        "bound": BOUND.load(Ordering::SeqCst),
        "lastPull": last_pull
    })
}

/// 手动清空回收站（彻底删除全部软删除项）
#[tauri::command]
fn purge_trash(app: tauri::AppHandle) -> u32 {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("notes");
    let mut n = 0u32;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x != "json")
                .unwrap_or(true)
            {
                continue;
            }
            if let Ok(text) = std::fs::read_to_string(&p) {
                let v: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if v.get("deleted").and_then(|x| x.as_bool()).unwrap_or(false) {
                    let id = v
                        .get("id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string();
                    let _ = std::fs::remove_file(&p);
                    if !id.is_empty() {
                        let _ = std::fs::remove_file(dir.join(format!("{}.ink", id)));
                        add_tomb(&dir, &id);
                    }
                    n += 1;
                }
            }
        }
    }
    n
}

// ---------------- 防火墙 ----------------

const FW_RULE: &str = "CloudNote-LAN-8787";
const FW_RULE_OLD: &str = "HarmonyNote-LAN";

/// 判断放行规则是否已存在（静默执行，不闪黑框）。
/// 兼容旧版本装过的 HarmonyNote-LAN 规则，避免升级后重复弹 UAC。
#[cfg(target_os = "windows")]
fn firewall_rule_exists() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    for name in [FW_RULE, FW_RULE_OLD] {
        let args: Vec<String> = vec![
            "advfirewall".into(),
            "firewall".into(),
            "show".into(),
            "rule".into(),
            format!("name={}", name),
        ];
        let out = std::process::Command::new("netsh")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = out {
            let txt = String::from_utf8_lossy(&o.stdout);
            if o.status.success() && txt.contains(name) {
                return true;
            }
        }
    }
    false
}

#[cfg(not(target_os = "windows"))]
fn firewall_rule_exists() -> bool {
    true
}

/// 前端启动时查询，决定是否提示用户放行
#[tauri::command]
fn firewall_status() -> bool {
    firewall_rule_exists()
}

/// 弹 UAC 请求管理员权限并添加放行规则；返回最终是否已放行。
/// 用户点「否」或账号无管理员权限时返回 false，前端会给出可重试的提示。
#[tauri::command]
async fn open_firewall() -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let script = format!(
            "$p = Start-Process -FilePath netsh -ArgumentList 'advfirewall','firewall','add','rule','name={}','dir=in','action=allow','protocol=TCP','localport={}','profile=any' -Verb RunAs -PassThru -WindowStyle Hidden -Wait; exit $p.ExitCode",
            FW_RULE, PORT
        );
        let ps_args: Vec<String> = vec![
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-WindowStyle".into(),
            "Hidden".into(),
            "-Command".into(),
            script,
        ];
        let out = std::process::Command::new("powershell")
            .args(ps_args)
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        if let Ok(o) = out {
            if o.status.success() {
                return true;
            }
        }
        // UAC 取消 / 权限不足时，再确认一次规则状态
        return firewall_rule_exists();
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            // 防火墙规则由安装程序（NSIS 钩子）在提权状态下添加；
            // 若被安全软件拦截或使用绿色版，前端启动时会检测并弹窗请求 UAC 放行。
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("notes");
            std::fs::create_dir_all(&dir).ok();

            let (_rx, _jh) = start_file_server(dir.clone(), PORT);

            // 关键：ServiceDaemon 一旦 drop 就会注销服务，mDNS 广播随之消失。
            // 之前用局部变量接住，函数返回即被释放，所以手机永远发现不到电脑。
            if let Some(daemon) = advertise(PORT) {
                std::mem::forget(daemon); // 常驻进程生命周期
            } else {
                eprintln!("mDNS 广播未启动（未取到本机 IPv4），请用手机端「用IP同步」");
            }

            println!(
                "云记事文件服务已启动: http://{}:{}  笔记目录 {:?}",
                local_ipv4()
                    .map(|x| x.to_string())
                    .unwrap_or_else(|| "127.0.0.1".into()),
                PORT,
                dir
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            notes_dir,
            open_notes_dir,
            list_notes,
            server_info,
            purge_trash,
            firewall_status,
            open_firewall
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
