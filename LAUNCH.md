# Launching

Everything is prepared; the only things this machine cannot do are the two that
need your credentials: pushing to GitHub and publishing to npm.

## One command

```bash
gh auth login        # once
npm login            # once
./scripts/launch.sh <github-user>
```

That points `package.json` and the README at `github.com/<user>/trace-viz`, runs the checks, creates the public
repo, pushes `main`, turns on GitHub Pages, and publishes. CI and the Pages
deploy run on every push from then on. The package is `trace-viz`, which is free on npm.

## By hand

```bash
git remote add origin git@github.com:<user>/trace-viz.git
git push -u origin main
npm publish --access public          # after renaming to @<scope>/visualize
```

Then in the repo settings, Pages → Source → *GitHub Actions*. The studio is at
`https://<user>.github.io/trace-viz/`, the plain mesh demo at `/mesh.html`, the
auth-challenge demo at `/auth.html`.

## Before the first push, worth deciding

- **LICENSE** says "Yatharth Saluja and trace-viz contributors". It already carries your name; change it if you want to
  hold the copyright.
