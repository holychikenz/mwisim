# csim — MWI combat simulator

Engine in `src/combatsimulator/`, React UI in `ui/`, headless API and tests in
`api/`. Everything builds through `./build.sh`:

```bash
./build.sh            # install, generate, build the UI (ui/dist/)
./build.sh check      # what CI runs
cd ui && npm run dev  # http://localhost:5173
```

See `ui/README.md` and `MWIX-RELATIONSHIP.md` for more.
