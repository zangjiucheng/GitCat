// Backend (app-authored) error strings for the in-app plugin catalogue
// (plugin_market.rs). Keys become `err_market.<key>` and are looked up by `be()`
// from the Rust `ierr`/`ierrp` machinery. English is the SOURCE OF TRUTH.
//
// Every one of these is a refusal to put bytes on disk, so each says WHAT was
// refused — a message that only says "download failed" sends the reader to the
// wrong place (their network) for what is usually a bad index entry.
export default {
  // Reaching the catalogue
  bad_index: "The plugin catalogue could not be read — {detail}",
  index_too_new:
    "This plugin catalogue is version {version}, which this GitCat does not understand. Update GitCat to browse it.",
  http_failed: "Could not reach the plugin catalogue — {detail}",
  http_status: "The plugin catalogue returned {status} for {url}.",

  // Refusing an entry before fetching anything
  host_not_allowed: "Refused to fetch {url} — plugins are only ever downloaded from GitHub.",
  bad_repo_url: "This catalogue entry's repository {url} is not a GitHub repository address.",
  bad_manifest_path: "This catalogue entry's manifest path {path} is not a plain path inside its repository.",
  entry_incomplete: "The catalogue entry for {id} is missing the fields needed to locate its files.",
  unknown_kind: "The catalogue lists a plugin of unknown kind {kind}; this GitCat only understands official and community entries.",

  // Refusing what a repository actually served
  unsafe_name: "Refused a file named {name} — a plugin's files must be plain names inside its own folder.",
  too_large: "{url} is larger than the {limit}-byte limit for one plugin file.",
  too_large_total: "This plugin's files exceed the {limit}-byte total limit.",
  too_many_files: "This plugin has more than {limit} files, which is more than a plugin should be.",
  bad_listing: "GitHub's file listing for this plugin could not be read — {detail}",
  no_manifest: "No plugin.json was found for {id} where the catalogue says its files live.",
  write_failed: "Could not write the downloaded plugin to disk — {detail}",
};
