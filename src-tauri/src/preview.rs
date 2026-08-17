//! Binary-blob preview (issue #37) — the raw bytes of an image or PDF blob on
//! one side of a diff, base64-encoded, so the diff panels can render a visual
//! before/after instead of the "binary file — not shown" placeholder.
//!
//! PURE READ. git2 for the object/index sides, `std::fs` for the working-tree
//! side. No mutation, no `crate::safety::snapshot` — there is nothing to back
//! up. The command is intentionally *side-addressed* by a `rev` string that
//! mirrors what the two diff panels already know how to build:
//!   - a commit rev-spec (`"<sha>"`, `"<sha>^"`, `"HEAD"`, …) -> that tree's blob
//!   - `":index"`   -> the staged (index) blob at `path`
//!   - `":workdir"` -> the on-disk working-tree file at `path`
//!
//! Any side where the path is absent resolves to `Ok(None)`, never an error:
//! an add has no old side, a delete has no new side, and a root commit's `"^"`
//! doesn't resolve. The caller then shows a single-sided preview without having
//! to special-case every A/D/M/R/C/T status itself.

use serde::Serialize;

use crate::i18n_err::{ierr, ierrp};

/// Hard cap on a previewed blob. Over this we still report the `mime`/`size`
/// but omit the bytes (`data: None`), so a giant vendored asset can't blow up
/// the IPC payload or the webview; the panel shows a "too large to preview"
/// note plus the size and offers the external-tool escape hatch.
const MAX_PREVIEW_BYTES: usize = 16 * 1024 * 1024;

/// One diff side's blob, ready for the frontend to build a `data:` URI (images)
/// or hand to pdf.js (PDFs). `data` is standard-base64 of the raw bytes, or
/// `None` when the blob is over [`MAX_PREVIEW_BYTES`].
#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlobPreview {
    /// MIME guessed from the path extension (`"image/png"`, `"application/pdf"`,
    /// …), so the frontend doesn't re-derive it.
    pub mime: String,
    /// Raw byte length of the blob on this side (reported even when `data` is
    /// omitted for being over the cap).
    pub size: usize,
    /// Standard-base64 of the raw bytes, or `None` when `size > MAX_PREVIEW_BYTES`.
    pub data: Option<String>,
}

/// Fetch one diff side's blob for an image/PDF preview. `rev` selects the side
/// (see the module doc). Returns `Ok(None)` when the path is absent on that
/// side. JS: `invoke("preview_blob", { repo, rev, path })`.
#[tauri::command]
#[specta::specta]
pub async fn preview_blob(
    repo: String,
    rev: String,
    path: String,
) -> Result<Option<BlobPreview>, String> {
    crate::blocking::run_blocking(move || preview_blob_inner(&repo, &rev, &path)).await
}

fn preview_blob_inner(repo: &str, rev: &str, path: &str) -> Result<Option<BlobPreview>, String> {
    let bytes = match read_side_bytes(repo, rev, path)? {
        Some(b) => b,
        None => return Ok(None),
    };
    let size = bytes.len();
    let data = if size > MAX_PREVIEW_BYTES {
        None
    } else {
        use base64::Engine;
        Some(base64::engine::general_purpose::STANDARD.encode(&bytes))
    };
    Ok(Some(BlobPreview {
        mime: mime_for_path(path).to_string(),
        size,
        data,
    }))
}

/// Save the raw bytes of the `rev` side of `file` to a user-picked `dest` path
/// (from the frontend's native `save()` dialog) — "download this before/after
/// version". `dest` is only ever consumed by `fs::write` (git never sees it),
/// so, like `export_patch`, only empty/NUL is guarded. JS:
/// `invoke("export_blob", { repo, rev, file, dest })`.
#[tauri::command]
#[specta::specta]
pub async fn export_blob(repo: String, rev: String, file: String, dest: String) -> Result<(), String> {
    crate::blocking::run_blocking(move || export_blob_inner(&repo, &rev, &file, &dest)).await
}

fn export_blob_inner(repo: &str, rev: &str, file: &str, dest: &str) -> Result<(), String> {
    if dest.is_empty() {
        return Err(ierr("err_ops.no_dest_file_chosen"));
    }
    if dest.contains('\0') {
        return Err(ierr("err_ops.dest_illegal_nul"));
    }
    let bytes = read_side_bytes(repo, rev, file)?.ok_or_else(|| {
        ierrp("err_ops.could_not_write_dest", &[("dest", dest), ("detail", "source not present on this side")])
    })?;
    std::fs::write(dest, &bytes)
        .map_err(|e| ierrp("err_ops.could_not_write_dest", &[("dest", dest), ("detail", &e.to_string())]))?;
    Ok(())
}

/// Read the raw bytes of `file` on the side named by `rev`. `Ok(None)` means
/// the path simply doesn't exist on that side (a normal one-sided add/delete,
/// or an unresolvable `"^"` on a root commit) — the caller treats that as
/// "nothing to show on this side", not a failure.
fn read_side_bytes(repo_path: &str, rev: &str, file: &str) -> Result<Option<Vec<u8>>, String> {
    let repo = crate::trust::open_repo(repo_path)
        .map_err(|e| ierrp("err_misc.cannot_open_repo", &[("detail", e.message())]))?;

    match rev {
        // The on-disk working-tree file (unstaged "new" side, or an untracked add).
        ":workdir" => {
            let wd = repo
                .workdir()
                .ok_or_else(|| ierrp("err_misc.cannot_open_repo", &[("detail", "bare repository")]))?;
            match std::fs::read(wd.join(file)) {
                Ok(b) => Ok(Some(b)),
                Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        // The staged (index) blob at `file`.
        ":index" => {
            let index = repo.index().map_err(|e| e.message().to_string())?;
            match index.get_path(std::path::Path::new(file), 0) {
                Some(entry) => {
                    let blob = repo.find_blob(entry.id).map_err(|e| e.message().to_string())?;
                    Ok(Some(blob.content().to_vec()))
                }
                None => Ok(None),
            }
        }
        // Any commit rev-spec -> resolve to a tree and read the path's blob.
        _ => {
            // A root commit's "<sha>^" (and any other unresolvable rev) is a
            // normal "no old side", not an error.
            let obj = match repo.revparse_single(rev) {
                Ok(o) => o,
                Err(_) => return Ok(None),
            };
            let tree = match obj.peel_to_tree() {
                Ok(t) => t,
                Err(_) => return Ok(None),
            };
            let entry = match tree.get_path(std::path::Path::new(file)) {
                Ok(e) => e,
                Err(_) => return Ok(None), // path not present on this side
            };
            let object = entry.to_object(&repo).map_err(|e| e.message().to_string())?;
            match object.as_blob() {
                Some(blob) => Ok(Some(blob.content().to_vec())),
                None => Ok(None), // a tree/submodule at that path, not a blob
            }
        }
    }
}

/// MIME from the path's extension. Kept in lockstep with the frontend's
/// `previewKind()` allow-list — anything not an image or PDF falls through to
/// `application/octet-stream` (the frontend never asks for those, but a plugin
/// or a future caller might).
fn mime_for_path(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// PDF page rasterization (issue #37)
//
// pdf.js cannot run in the Tauri WKWebView (its worker never completes the
// load handshake; on the main thread it freezes the UI). So a PDF diff side is
// rasterized HERE with PDFium — off the UI thread via `run_blocking` — and the
// frontend shows the resulting PNG through the same image path.
// ---------------------------------------------------------------------------

use std::sync::mpsc::{self, Sender};
use std::sync::OnceLock;

/// Bounds on the caller-requested render width (device px): the inline panel
/// asks for ~1240; the zoom lightbox asks for more so it stays crisp magnified.
const PDF_MIN_WIDTH: u32 = 400;
const PDF_MAX_WIDTH: u32 = 5000;

/// One rasterized PDF page: a PNG (base64) plus its pixel size and the doc's
/// total page count (so the frontend can page through).
#[derive(Serialize, specta::Type, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PdfRender {
    /// Standard-base64 PNG of the rendered page.
    pub data: String,
    pub width: u32,
    pub height: u32,
    /// Total pages in the document.
    pub page_count: u32,
}

/// Rasterize page `page` (1-based) of the PDF blob on the `rev` side of a diff.
/// `Ok(None)` when the side is absent (same convention as [`preview_blob`]).
/// JS: `invoke("render_pdf_page", { repo, rev, path, page })`.
#[tauri::command]
#[specta::specta]
pub async fn render_pdf_page(
    app: tauri::AppHandle<tauri::Wry>,
    repo: String,
    rev: String,
    path: String,
    page: u32,
    max_width: u32,
) -> Result<Option<PdfRender>, String> {
    // Resolve the bundled PDFium library on the async side (needs the app
    // handle); the read + rasterize run off the UI thread.
    let lib = resolve_pdfium_lib(&app)?;
    let width = max_width.clamp(PDF_MIN_WIDTH, PDF_MAX_WIDTH) as i32;
    crate::blocking::run_blocking(move || {
        let bytes = match read_side_bytes(&repo, &rev, &path)? {
            Some(b) => b,
            None => return Ok(None),
        };
        // Hand the work to the single PDFium thread and wait for its answer.
        let (tx, rx) = mpsc::channel();
        pdfium_thread()
            .send(RenderJob { bytes, page, width, lib, resp: tx })
            .map_err(|_| "pdf render thread unavailable".to_string())?;
        rx.recv().map_err(|_| "pdf render thread dropped the job".to_string())?
    })
    .await
}

/// A render request handed to the dedicated PDFium thread.
struct RenderJob {
    bytes: Vec<u8>,
    page: u32,
    width: i32,
    lib: std::path::PathBuf,
    resp: Sender<Result<Option<PdfRender>, String>>,
}

/// `Pdfium` is not `Send` (its FFI bindings can't cross threads) and PDFium's
/// `FPDF_InitLibrary` is process-global, so ALL rasterization runs on ONE
/// dedicated thread that owns the instance for the app's lifetime. Callers post
/// a [`RenderJob`] and block on its reply channel — from `run_blocking`'s pool,
/// never the UI thread. Serializing previews this way is fine (they're rare and
/// each page renders in a few ms).
fn pdfium_thread() -> &'static Sender<RenderJob> {
    static TX: OnceLock<Sender<RenderJob>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<RenderJob>();
        std::thread::Builder::new()
            .name("pdfium-render".into())
            .spawn(move || {
                use pdfium_render::prelude::*;
                let mut pdfium: Option<Pdfium> = None;
                for job in rx {
                    let result = (|| -> Result<Option<PdfRender>, String> {
                        if pdfium.is_none() {
                            let bindings = Pdfium::bind_to_library(&job.lib)
                                .map_err(|e| format!("PDFium load failed: {e}"))?;
                            pdfium = Some(Pdfium::new(bindings));
                        }
                        rasterize(pdfium.as_ref().unwrap(), &job.bytes, job.page, job.width)
                    })();
                    let _ = job.resp.send(result);
                }
            })
            .expect("spawn pdfium-render thread");
        tx
    })
}

/// Rasterize one page to a PNG. Runs only on the PDFium thread (see
/// [`pdfium_thread`]).
fn rasterize(
    pdfium: &pdfium_render::prelude::Pdfium,
    bytes: &[u8],
    page: u32,
    width: i32,
) -> Result<Option<PdfRender>, String> {
    use pdfium_render::prelude::*;

    let doc = pdfium
        .load_pdf_from_byte_slice(bytes, None)
        .map_err(|e| format!("PDF open failed: {e}"))?;
    let pages = doc.pages();
    let count = pages.len(); // u16
    if count == 0 {
        return Ok(None);
    }
    let idx = page.saturating_sub(1).min(count as u32 - 1) as u16;
    let pdf_page = pages.get(idx).map_err(|e| format!("PDF page failed: {e}"))?;

    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .set_maximum_height(width * 4);
    let image = pdf_page
        .render_with_config(&config)
        .map_err(|e| format!("PDF render failed: {e}"))?
        .as_image();
    let (width, height) = (image.width(), image.height());

    let mut buf = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encode failed: {e}"))?;

    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok(Some(PdfRender {
        data,
        width,
        height,
        page_count: count as u32,
    }))
}

/// Resolve the bundled PDFium library path. Tries the app's Resource dir first
/// (release + `tauri build`), then the in-repo `resources/pdfium/` copy that
/// `tauri dev` runs against.
fn resolve_pdfium_lib(app: &tauri::AppHandle<tauri::Wry>) -> Result<std::path::PathBuf, String> {
    use pdfium_render::prelude::Pdfium;
    use tauri::Manager;

    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve("pdfium", tauri::path::BaseDirectory::Resource)
    {
        dirs.push(p);
    }
    dirs.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium"));

    for dir in &dirs {
        // Appends the platform library name (libpdfium.dylib / pdfium.dll /
        // libpdfium.so) to the folder.
        let candidate = Pdfium::pdfium_platform_library_name_at_path(dir);
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("PDFium library not found (resources/pdfium)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // A 1x1 PNG (67 bytes) — enough to prove round-trip byte fidelity through
    // git's object store and back out as base64.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn decode(data: &Option<String>) -> Vec<u8> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(data.as_ref().expect("data present"))
            .expect("valid base64")
    }

    /// A unique temp dir that cleans itself up on drop — including when a test
    /// panics on a failed assert, which the codebase's plain end-of-test
    /// `remove_dir_all` idiom would leak.
    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let d = std::env::temp_dir().join(format!(
                "gitcat-preview-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&d).unwrap();
            Tmp(d)
        }
        fn path(&self) -> &Path {
            &self.0
        }
        fn repo(&self) -> String {
            self.0.to_str().unwrap().to_string()
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // Build a repo with one commit adding logo.png, a second replacing its
    // bytes, so both the new (`HEAD`) and old (`HEAD^`) commit sides are
    // exercised. Returns the temp-dir guard (hold it for the test's lifetime)
    // and HEAD's full sha.
    fn setup(tag: &str) -> (Tmp, String) {
        let dir = Tmp::new(tag);
        let repo = git2::Repository::init(dir.path()).unwrap();
        let sig = git2::Signature::now("T", "t@e.x").unwrap();

        // Commit 1: add logo.png (the 1x1 PNG).
        std::fs::write(dir.path().join("logo.png"), PNG_1X1).unwrap();
        let c1 = {
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("logo.png")).unwrap();
            idx.write().unwrap();
            let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "add logo", &tree, &[])
                .unwrap()
        };

        // Commit 2: modify logo.png (append a byte so the blob oid changes).
        let mut modified = PNG_1X1.to_vec();
        modified.push(0xAB);
        std::fs::write(dir.path().join("logo.png"), &modified).unwrap();
        let c2 = {
            let parent = repo.find_commit(c1).unwrap();
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("logo.png")).unwrap();
            idx.write().unwrap();
            let tree = repo.find_tree(idx.write_tree().unwrap()).unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "tweak logo", &tree, &[&parent])
                .unwrap()
        };

        (dir, c2.to_string())
    }

    #[test]
    fn commit_side_round_trips_bytes() {
        let (dir, head) = setup("newside");
        let path = dir.repo();
        // New side (HEAD) is the modified blob.
        let got = preview_blob_inner(&path, &head, "logo.png").unwrap().unwrap();
        assert_eq!(got.mime, "image/png");
        let mut expected = PNG_1X1.to_vec();
        expected.push(0xAB);
        assert_eq!(decode(&got.data), expected);
        assert_eq!(got.size, expected.len());
    }

    #[test]
    fn parent_side_reads_original_blob() {
        let (dir, head) = setup("oldside");
        let path = dir.repo();
        // Old side ("<sha>^") is the original, unmodified blob.
        let got = preview_blob_inner(&path, &format!("{head}^"), "logo.png")
            .unwrap()
            .unwrap();
        assert_eq!(decode(&got.data), PNG_1X1);
    }

    #[test]
    fn absent_path_and_unresolvable_rev_are_none() {
        let (dir, head) = setup("absent");
        let path = dir.repo();
        // Path not in the tree -> None (not an error).
        assert!(preview_blob_inner(&path, &head, "missing.png").unwrap().is_none());
        // A garbage rev is a "no side", not a hard error.
        assert!(preview_blob_inner(&path, "does-not-exist", "logo.png").unwrap().is_none());
    }

    #[test]
    fn workdir_and_index_sides() {
        let (dir, _head) = setup("workdir");
        let path = dir.repo();
        let repo = git2::Repository::open(&path).unwrap();

        // Unstaged edit on disk -> :workdir sees the new bytes.
        let mut wd_bytes = PNG_1X1.to_vec();
        wd_bytes.extend_from_slice(&[1, 2, 3]);
        std::fs::write(dir.path().join("logo.png"), &wd_bytes).unwrap();
        let wd = preview_blob_inner(&path, ":workdir", "logo.png")
            .unwrap()
            .unwrap();
        assert_eq!(decode(&wd.data), wd_bytes);

        // Stage it -> :index now holds those same bytes.
        {
            let mut idx = repo.index().unwrap();
            idx.add_path(Path::new("logo.png")).unwrap();
            idx.write().unwrap();
        }
        let staged = preview_blob_inner(&path, ":index", "logo.png")
            .unwrap()
            .unwrap();
        assert_eq!(decode(&staged.data), wd_bytes);

        // A never-staged path is absent from the index -> None.
        assert!(preview_blob_inner(&path, ":index", "nope.png").unwrap().is_none());
    }

    // A minimal one-page (blank, 200x200) PDF — enough to exercise the whole
    // rasterize pipeline (load -> page -> render -> PNG encode).
    const MINIMAL_PDF: &[u8] = b"%PDF-1.4\n\
1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n\
2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n\
3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>endobj\n\
trailer<< /Root 1 0 R >>\n%%EOF";

    #[test]
    fn rasterizes_a_pdf_page_when_lib_present() {
        use pdfium_render::prelude::*;
        // Uses the in-repo dev copy of PDFium; skip (don't fail) when it isn't
        // fetched — a fresh CI runner without `pnpm install`/fetch-pdfium.mjs.
        let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/pdfium");
        let lib = Pdfium::pdfium_platform_library_name_at_path(&dir);
        if !lib.exists() {
            eprintln!("skipping rasterize test: PDFium lib not present at {lib:?}");
            return;
        }
        let pdfium = Pdfium::new(Pdfium::bind_to_library(&lib).expect("bind pdfium"));
        let out = rasterize(&pdfium, MINIMAL_PDF, 1, 1240)
            .expect("rasterize ok")
            .expect("a render");
        assert_eq!(out.page_count, 1);
        assert!(out.width > 0 && out.height > 0);
        // Decoded data starts with the PNG magic bytes.
        use base64::Engine;
        let png = base64::engine::general_purpose::STANDARD.decode(&out.data).unwrap();
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']);
    }

    #[test]
    fn export_blob_writes_raw_bytes_and_guards_dest() {
        let (dir, head) = setup("export");
        let repo = dir.repo();
        let dest = dir.path().join("out.png");
        let dest_s = dest.to_str().unwrap();

        // New side (HEAD) is the modified 1x1 PNG.
        export_blob_inner(&repo, &head, "logo.png", dest_s).expect("export ok");
        let mut expected = PNG_1X1.to_vec();
        expected.push(0xAB);
        assert_eq!(std::fs::read(&dest).unwrap(), expected);

        // An empty destination is rejected (i18n:err_ops.no_dest_file_chosen).
        let err = export_blob_inner(&repo, &head, "logo.png", "").unwrap_err();
        assert!(err.contains("no_dest_file_chosen"), "got: {err}");

        // A path absent on the side surfaces an error rather than writing.
        let miss = dir.path().join("miss.png");
        assert!(export_blob_inner(&repo, &head, "nope.png", miss.to_str().unwrap()).is_err());
        assert!(!miss.exists());
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_for_path("a/b/c.PNG"), "image/png");
        assert_eq!(mime_for_path("x.jpeg"), "image/jpeg");
        assert_eq!(mime_for_path("x.svg"), "image/svg+xml");
        assert_eq!(mime_for_path("doc.pdf"), "application/pdf");
        assert_eq!(mime_for_path("data.bin"), "application/octet-stream");
        assert_eq!(mime_for_path("noext"), "application/octet-stream");
    }
}
