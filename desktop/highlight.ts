const KEYWORDS: Record<string, string> = {
  javascript: "as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch throw try typeof undefined var void while with yield satisfies type namespace declare readonly abstract enum keyof infer unknown never any number string boolean symbol object",
  elixir: "after alias and case catch cond def defdelegate defexception defguard defimpl defmacro defmodule defp defprotocol defstruct do else end fn for if import in not or quote raise receive require rescue super throw try unless unquote use when with",
  python: "and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield",
  ruby: "alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield",
  shell: "case do done elif else esac export fi for function if in local readonly return select set shift then time trap until while",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
  c: "alignas alignof auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern false float for friend goto if inline int long mutable namespace new nullptr operator private protected public register reinterpret_cast return short signed sizeof static static_assert struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while",
  sql: "add all alter and any as asc between by case check column constraint create database default delete desc distinct drop else end exists foreign from full group having in index inner insert into is join key left like limit not null on or order outer primary references right row select set table then union unique update values view when where with",
  css: "and important not only or var",
  yaml: "true false null yes no on off",
  markup: "doctype"
};

const keywordSets = Object.fromEntries(Object.entries(KEYWORDS).map(([language, words]) => [language, new Set(words.split(" "))]));

const extensionLanguages = new Map(Object.entries({
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", ts: "javascript", tsx: "javascript", vue: "markup",
  ex: "elixir", exs: "elixir", py: "python", pyw: "python", rb: "ruby", rake: "ruby",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  rs: "rust", c: "c", h: "c", cc: "c", cpp: "c", cxx: "c", hpp: "c", java: "c", kt: "c", kts: "c", swift: "c",
  sql: "sql", json: "javascript", jsonc: "javascript", css: "css", scss: "css", less: "css",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", svelte: "markup",
  yaml: "yaml", yml: "yaml", toml: "yaml", md: "markdown", markdown: "markdown"
}));

function languageForFile(filePath: string) {
  const base = (String(filePath || "").replaceAll("\\", "/").split("/").at(-1) || "").toLowerCase();
  if (["dockerfile", "makefile", "justfile"].includes(base)) return "shell";
  return extensionLanguages.get(base.includes(".") ? base.split(".").at(-1)! : "") || "plain";
}

type Token = { type: string; text: string };
function add(tokens: Token[], type: string, text: string) {
  if (!text) return;
  const previous = tokens.at(-1);
  if (previous?.type === type) previous.text += text;
  else tokens.push({ type, text });
}

function commentMarker(language: string) {
  if (["python", "ruby", "shell", "elixir", "yaml"].includes(language)) return "#";
  if (language === "sql") return "--";
  if (["javascript", "rust", "c"].includes(language)) return "//";
  return null;
}

export function tokenizeLine(value: string, filePath = "") {
  const source = String(value ?? "");
  const language = languageForFile(filePath);
  if (language === "markdown" && /^\s{0,3}#{1,6}\s/.test(source)) return [{ type: "heading", text: source }];

  const tokens: Token[] = [];
  const keywords = keywordSets[language] || new Set();
  const marker = commentMarker(language);
  let index = 0;

  while (index < source.length) {
    const rest = source.slice(index);
    if (rest.startsWith("<!--")) { add(tokens, "comment", rest); break; }
    if (rest.startsWith("/*")) { add(tokens, "comment", rest); break; }
    if (marker && rest.startsWith(marker)) { add(tokens, "comment", rest); break; }

    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      const quote = character;
      let end = index + 1;
      while (end < source.length) {
        if (source[end] === "\\") { end += 2; continue; }
        end += 1;
        if (source[end - 1] === quote) break;
      }
      add(tokens, "string", source.slice(index, end));
      index = end;
      continue;
    }

    const number = rest.match(/^(?:0x[\da-f]+|0b[01]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i);
    if (number) { add(tokens, "number", number[0]); index += number[0].length; continue; }

    const atom = language === "elixir" ? rest.match(/^:[a-zA-Z_][\w!?]*/) : null;
    if (atom) { add(tokens, "literal", atom[0]); index += atom[0].length; continue; }

    const identifier = rest.match(/^[@$a-zA-Z_][\w$!?-]*/);
    if (identifier) {
      const word = identifier[0];
      const afterIndex = index + word.length;
      const next = source.slice(afterIndex).match(/^\s*(.)/)?.[1] || "";
      const before = source.slice(0, index);
      let type = "plain";
      if (keywords.has(word) || keywords.has(word.toLowerCase())) type = "keyword";
      else if (["true", "false", "null", "nil", "None", "undefined"].includes(word)) type = "literal";
      else if (language === "markup" && /<\/?$/.test(before)) type = "tag";
      else if (next === "(" || (language === "elixir" && ["def", "defp", "defmacro"].includes(tokens.at(-1)?.text.trim() || ""))) type = "function";
      else if (next === ":" || (language === "markup" && next === "=")) type = "property";
      else if (/^[A-Z]/.test(word) || word.startsWith("@")) type = "type";
      add(tokens, type, word);
      index = afterIndex;
      continue;
    }

    const operator = rest.match(/^(?:=>|->|<-|===|!==|==|!=|<=|>=|&&|\|\||\|>|::|\.\.|[+*/%=<>!&|^-]+)/);
    if (operator) { add(tokens, "operator", operator[0]); index += operator[0].length; continue; }
    add(tokens, "plain", character);
    index += 1;
  }
  return tokens;
}
