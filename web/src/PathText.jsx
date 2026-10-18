import { send } from "./api";

// Same extensions the server will open (server/open.mjs OPEN_EXT).
const PATH_RE = /(?<![\w:/.~@+-])((?:~\/|\/|\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+ -]+)*\.(?:pdf|xlsx|xls|csv|ipynb|html?|md|txt|json|docx|pptx|png|jpe?g|svg))(?![\w/])/gi;

export function OpenBtn({ path, slug }) {
  return (
    <button
      className="x open-btn"
      title={"open " + path}
      onClick={(e) => {
        e.stopPropagation();
        send("POST", "/open", { path, slug }).catch((err) => alert("Can't open " + path + ": " + err.message));
      }}
    >
      open
    </button>
  );
}

// Renders `text` and puts an open button after every file path in it.
export default function PathText({ text, slug }) {
  const parts = String(text ?? "").split(PATH_RE); // odd indexes = the captured paths
  return parts.map((s, i) =>
    i % 2 ? (
      <span key={i}>
        {s}
        <OpenBtn path={s} slug={slug} />
      </span>
    ) : (
      s
    ),
  );
}
