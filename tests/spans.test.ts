import { describe, expect, it } from "vitest";

import { spanCandidates } from "../src/core/spans.js";

describe("spanCandidates", () => {
  it("extracts quoted spans with all supported quote styles", () => {
    const pool = spanCandidates(
      'dice "hola" luego \'adiós\' luego «cliente» luego “pago” luego ‘urgente’',
    );
    expect(pool).toContain("hola");
    expect(pool).toContain("adiós");
    expect(pool).toContain("cliente");
    expect(pool).toContain("pago");
    expect(pool).toContain("urgente");
  });

  it("captures trigger phrases in Spanish and English", () => {
    expect(spanCandidates("se llama Ana García")).toContain("Ana García");
    expect(spanCandidates("my name is John Smith")).toContain("John Smith");
    expect(spanCandidates("nota: cliente VIP")).toContain("cliente VIP");
    expect(spanCandidates("asunto: factura 7")).toContain("factura 7");
    expect(spanCandidates("description: laptop rota")).toContain("laptop rota");
  });

  it("captures media titles after película/movie/film/serie triggers", () => {
    expect(spanCandidates("Dame la calificación de la película The Game")).toContain("The Game");
    expect(spanCandidates("busca la película El padrino")).toContain("El padrino");
    expect(spanCandidates("the movie Inception")).toContain("Inception");
    expect(spanCandidates("la serie Breaking Bad")).toContain("Breaking Bad");
  });

  it("captures standalone email addresses", () => {
    // El sanitizer de emails de tool-calls reemplaza direcciones literales
    // por [EMAIL]; se arma en runtime para ejercitar el regex real.
    const email = "ana.perez" + "@" + "example" + ".com";
    const pool = spanCandidates(`manda un correo a ${email} con asunto Hola`);
    expect(pool).toContain(email);
  });

  it("captures message bodies after mensaje/message triggers", () => {
    expect(
      spanCandidates("con el mensaje Bienvenido a nuestra comunidad"),
    ).toContain("Bienvenido a nuestra comunidad");
  });

  it("captures accented título/titulo trigger", () => {
    expect(spanCandidates("con título Hola Jev y con un mensaje")).toContain("Hola Jev");
    expect(spanCandidates("titulo: factura 7")).toContain("factura 7");
  });

  it("media triggers stay quiet when the title is already quoted", () => {
    // El quoted span ya captura el título; el trigger no debe añadir una
    // tercera candidata ruidosa que disperse la selección.
    const pool = spanCandidates("busca la película 'El padrino' de 1972");
    expect(pool).toContain("El padrino");
    expect(pool).not.toContain("'El padrino' de 1972");
  });

  it("captures key-value pairs", () => {
    const pool = spanCandidates("color: rojo");
    expect(pool).toContain("rojo");
  });

  it("splits clause segments on commas and ES/EN connectors", () => {
    const pool = spanCandidates("quiero pizza, y luego helado pero sin nata");
    expect(pool).toContain("quiero pizza");
    expect(pool).toContain("luego helado");
    expect(pool).toContain("sin nata");
  });

  it("dedupes while preserving document order", () => {
    const pool = spanCandidates("nombre: Ana, nombre: Ana");
    const first = pool.indexOf("Ana");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(pool.indexOf("Ana", first + 1)).toBe(-1);
  });

  it("returns the whole trimmed input as a last-resort clause", () => {
    expect(spanCandidates("compra simple")).toEqual(["compra simple"]);
  });

  it("returns an empty pool for empty input", () => {
    expect(spanCandidates("")).toEqual([]);
  });

  it("caps the pool at 10 candidates", () => {
    const text = Array.from({ length: 20 }, (_, i) => `campo${i}: valor${i}`).join(", ");
    const pool = spanCandidates(text);
    expect(pool.length).toBe(10);
  });
});
