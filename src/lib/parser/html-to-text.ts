/**
 * Konwersja HTML → tekst, dostrojona pod maile transakcyjne.
 *
 * Maile z Otodom są zbudowane na zagnieżdżonych tabelach, więc naiwne
 * `replace(/<[^>]+>/g, "")` sklejałoby etykiety z wartościami w jedną linię
 * i psuło dopasowanie wzorców. Tutaj każda komórka i wiersz tabeli kończy się
 * złamaniem linii, a adresy z `href` są zachowywane w tekście — dzięki temu
 * link do ogłoszenia przetrwa konwersję.
 *
 * Świadomie bez zewnętrznej zależności: wejście jest zaufane w tym sensie, że
 * nigdy nie renderujemy go w przeglądarce — tylko przepuszczamy przez regexy.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  bdquo: "„",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  bull: "•",
  middot: "·",
  euro: "€",
  copy: "©",
  reg: "®",
  trade: "™",
  oacute: "ó",
  Oacute: "Ó",
  aacute: "á",
  eacute: "é",
  szlig: "ß",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
};

export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }

    const named = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    return named ?? match;
  });
}

/** Znaczniki, po których wstawiamy złamanie linii. */
const BLOCK_END =
  /<\/?(?:br|p|div|tr|table|thead|tbody|li|ul|ol|h[1-6]|section|article|header|footer|blockquote|hr)\b[^>]*>/gi;

/** Komórki tabeli rozdzielamy tabulatorem — potem zamienimy go na złamanie linii. */
const CELL_END = /<\/(?:td|th)\s*>/gi;

export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";

  let text = html;

  // 1. Wycinamy wszystko, co nie jest treścią.
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  text = text.replace(/<\/?(?:o:p|xml|meta|link)\b[^>]*>/gi, " ");

  // 2. Linki: zachowujemy zarówno tekst, jak i adres.
  text = text.replace(
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_match, dq: string | undefined, sq: string | undefined, bare: string | undefined, label: string) => {
      const href = (dq ?? sq ?? bare ?? "").trim();
      const inner = label.replace(/<[^>]+>/g, "").trim();
      if (!href) return inner;
      if (!inner || inner === href) return ` ${href} `;
      return ` ${inner} ${href} `;
    },
  );

  // 3. Obrazki: alt bywa jedynym nośnikiem tekstu w mailach graficznych.
  text = text.replace(/<img\b[^>]*?alt\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ");

  // 4. Struktura → złamania linii.
  text = text.replace(CELL_END, "\n");
  text = text.replace(BLOCK_END, "\n");

  // 5. Reszta znaczników znika.
  text = text.replace(/<[^>]+>/g, " ");

  // 6. Encje i normalizacja białych znaków.
  text = decodeHtmlEntities(text);
  text = text.replace(/ /g, " ");
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(/[\t ]+/g, " ");
  text = text
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}
