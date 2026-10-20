import { send } from "./api";
import { alertDialog } from "./dialog.jsx";

// Same extensions the server will open (server/open.mjs OPEN_EXT).
const PATH_RE = /(?<![\w:/.~@+-])((?:~\/|\/|\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+ -]+)*\.(?:pdf|xlsx|xls|csv|ipynb|html?|md|txt|json|docx|pptx|png|jpe?g|svg))(?![\w/])/gi;

export function FileLink({ path, slug, children }) {
  return (
    <button
      type="button"
      className="file-link"
      title={"open " + path}
      onClick={(e) => {
        e.stopPropagation();
        send("POST", "/open", { path, slug }).catch((err) => alertDialog("Can't open " + path + ": " + err.message));
      }}
    >
      {children ?? path}
    </button>
  );
}

// Renders `text` and turns every file path in it into a clickable link.
export default function PathText({ text, slug }) {
  const parts = String(text ?? "").split(PATH_RE); // odd indexes = the captured paths
  return parts.map((s, i) =>
    i % 2 ? (
      <FileLink key={i} path={s} slug={slug} />
    ) : (
      s
    ),
  );
}
