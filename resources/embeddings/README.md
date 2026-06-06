# Bundled embedding model (local semantic code search)

LoCoPilot's `semanticSearch` tool computes embeddings **fully on the user's machine** using a
bundled ONNX model run by `onnxruntime-node` in the shared (utility) process. No external server,
no user install, identical behaviour for local and cloud chat models. The per-workspace vector
index is stored only under each workspace's `.locopilot/` folder and never leaves the machine.

## Model

- **bge-small-en-v1.5** — MIT licensed (BAAI), 384-dim, ~30MB quantized. BERT WordPiece tokenizer
  (handled by `src/vs/platform/embeddings/node/wordpieceTokenizer.ts`).

## Getting the model files

The weights are not committed to git. Fetch them before building/packaging:

```bash
node scripts/fetch-embedding-model.mjs
```

This populates:

```
resources/embeddings/bge-small-en-v1.5/
  ├── model.onnx     (quantized ONNX weights)
  └── vocab.txt      (WordPiece vocabulary)
```

At runtime the service loads them from `<appRoot>/resources/embeddings/bge-small-en-v1.5/`.

## Packaging checklist (must be validated with a full build)

1. `node scripts/fetch-embedding-model.mjs` so the files exist.
2. Ensure `resources/embeddings/**` is copied into the packaged app (gulp `resources` globs in
   `build/gulpfile.vscode*.ts`).
3. Ensure `onnxruntime-node` is treated as a bundled **native** module (its `.node` binaries must
   be ASAR-unpacked; see how `node-pty` / `@vscode/sqlite3` are handled in `build/` and
   `build/.moduleignore`).
4. Verify the shared process can `import('onnxruntime-node')` in the packaged app.

If any of the above is missing, `IEmbeddingComputeService.isAvailable()` returns false and
LoCoPilot falls back to a configured embedding endpoint / Ollama, or disables semantic search
gracefully — nothing breaks.
