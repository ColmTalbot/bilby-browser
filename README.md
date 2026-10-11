# bilby in the browser

Run the [bilby](https://github.com/bilby-dev/bilby) examples in the browser
with [Pyodide](https://pyodide.org). See `PLAN.md` for the plan, `NOTES.md`
for background and `LOCAL-ONLY.md` for what is still tied to this machine.

## Where bilby comes from

`bilby-commit.txt` pins one commit of
[bilby-dev/bilby](https://github.com/bilby-dev/bilby). `scripts/fetch-bilby.sh`
takes both the examples (`examples/`, without notebooks) and a bilby wheel
(`wheels/`) from that commit, so the examples always match the bilby that runs
them. Neither is stored in this repository. To move to the current `main`:

```bash
scripts/fetch-bilby.sh --update
```

## Run locally

```bash
scripts/dev.sh
```

then open http://localhost:8000. Pick an example from the tree, edit it if you
like, and press Run (Ctrl/⌘+Enter). Stop restarts Python.

## Run examples headlessly (Node)

```bash
npm install
scripts/dev.sh   # once, to fetch bilby and the wheels (Ctrl-C after it starts serving)
node scripts/test-examples.mjs core_examples/linear_regression.py
```

## Layout

- `index.html`, `app.js`: page, example tree, editor, output
- `worker.js`: Pyodide in a Web Worker; installs bilby, and LALSuite on the first GW example
- `py/bootstrap.py`: Python side, shared by the worker and the Node runner
- `examples/`, `wheels/`: generated, not committed (see above)
- `scripts/`: bilby fetch, dev server, manifest generator, Node runner
