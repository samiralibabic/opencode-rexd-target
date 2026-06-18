import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildRemoteReadRpcParams,
  formatReadOutput,
  isBinaryReadFile,
  readLocalResolvedPath,
  sniffReadMime,
} from "./rexd-target"

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "opencode-rexd-target-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("read helpers", () => {
  test("formats text reads with offset and limit", () => {
    expect(formatReadOutput("alpha\nbeta\ngamma", 2, 1)).toBe("2: beta")
  })

  test("attaches supported images detected from content", () => {
    const dir = tempDir()
    const file = join(dir, "image.bin")
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])
    writeFileSync(file, jpeg)

    const result = readLocalResolvedPath(file)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected attachment result")
    expect(result.output).toBe("Image read successfully")
    expect(result.attachments?.[0].mime).toBe("image/jpeg")
    expect(result.attachments?.[0].url).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`)
  })

  test("attaches PDFs", () => {
    const dir = tempDir()
    const file = join(dir, "example.pdf")
    const pdf = Buffer.from("%PDF-1.4\n")
    writeFileSync(file, pdf)

    const result = readLocalResolvedPath(file)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected attachment result")
    expect(result.output).toBe("PDF read successfully")
    expect(result.attachments?.[0].mime).toBe("application/pdf")
  })

  test("keeps printable unsupported image types as text", () => {
    const dir = tempDir()
    const file = join(dir, "image.bmp")
    writeFileSync(file, "BM text content")

    const result = readLocalResolvedPath(file)
    expect(result).toContain("BM text content")
  })

  test("rejects unsupported binary files", () => {
    const dir = tempDir()
    const file = join(dir, "module.wasm")
    writeFileSync(file, "not really wasm")

    expect(() => readLocalResolvedPath(file)).toThrow("Cannot read binary file")
    expect(isBinaryReadFile("null-byte.txt", Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
  })

  test("reads directories with opencode-style metadata", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "folder"))
    writeFileSync(join(dir, "file.txt"), "hello")

    const result = readLocalResolvedPath(dir)
    expect(typeof result).toBe("object")
    if (typeof result === "string") throw new Error("expected directory result")
    expect(result.output).toContain("<type>directory</type>")
    expect(result.metadata?.display).toMatchObject({
      type: "directory",
      entries: ["file.txt", "folder/"],
      totalEntries: 2,
    })
  })

  test("sniffs media signatures before extension fallback", () => {
    expect(sniffReadMime("photo.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    )
    expect(sniffReadMime("photo.webp", Buffer.from("text"))).toBe("image/webp")
  })

  test("builds remote base64 read params without line slicing", () => {
    expect(buildRemoteReadRpcParams({ sessionID: "s_1", path: "/srv/image.png", encoding: "base64" })).toEqual({
      session_id: "s_1",
      path: "/srv/image.png",
      encoding: "base64",
    })
    expect(
      buildRemoteReadRpcParams({ sessionID: "s_1", path: "/srv/image.png", encoding: "base64", length: 4096 }),
    ).toEqual({
      session_id: "s_1",
      path: "/srv/image.png",
      encoding: "base64",
      length: 4096,
    })
  })
})
