# csim — MWI combat simulator

Engine in `src/combatsimulator/`, React UI in `ui/`, headless API and tests in
`api/`. Everything builds through `./build.sh`:

```bash
./build.sh            # install, generate, build the UI (ui/dist/)
./build.sh check      # what CI runs
cd ui && npm run dev  # http://localhost:5173
```

## Refreshing game data

`src/combatsimulator/data/*.json` is the game's own catalogue, one file per
top-level key of the `init_client_data` message. MWIX captures that message in
a live game tab and the webapp writes it to `cowstuff/milkyway_client_info.json`;
this repo is refreshed from that file and from nothing else:

```bash
node tools/refreshData.mjs --check   # what would change
node tools/refreshData.mjs           # write
./build.sh gen                       # generated tables follow the data
./build.sh check                     # then read any red case
```

The last two steps are not optional. The generated tables are a pure function
of this data, and the eval baseline in `fixtures/eval/` was recorded against
the old numbers, so a game patch lands as a failing check. That failure is the
point: read it, decide whether it is the game or a bug, and only then
`npm run eval:record` in `api/`.

Pass a path to refresh from a dump elsewhere. Nothing is auto-discovered, which
is what keeps test-server data out of the bundle.

See `ui/README.md` and `MWIX-RELATIONSHIP.md` for more.
