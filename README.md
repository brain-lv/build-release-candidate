# Build Release Candidate

An intelligent, self-healing GitHub Action designed to orchestrate release candidate branches. 

Instead of manually resolving complex merge conflicts when building a release, this action uses pattern-based matching (Prefix, Suffix, or Regex) to selectively cherry-pick commits from a development branch. If a commit introduces a merge conflict, the action automatically acts as a dependency detective: it identifies the conflicting files, prunes the invalid ticket from the build list, and seamlessly restarts the pipeline to guarantee a clean, stable release branch.

## ✨ Features

* **Pattern-Based Cherry-Picking:** Target commits using Jira prefixes (e.g., `PROJ-`), suffixes, or advanced Regex patterns.
* **Self-Healing Pipeline:** Automatically strips invalid or conflicting tickets and rebuilds the branch from scratch, ensuring partial features are never deployed.
* **Dependency Detective:** Cross-references skipped commits to suggest exact missing dependencies when a merge conflict occurs.
* **Interactive HTML Dashboard:** Generates a visually rich, dark-mode compatible dashboard published directly to GitHub Pages detailing applied commits, skipped commits, and exactly why a build failed.
* **Optional Validation Loop:** Integrates with your existing CI test scripts to validate the branch dynamically after every applied commit.

---

## 🚀 Usage

To use this action, create a new workflow file in your repository (e.g., `.github/workflows/build-release-candidate.yml`). 

Because this action requires access to your full Git commit history to calculate merge bases, **you must set `fetch-depth: 0` in your checkout step.**

```yaml
name: Draft Release Candidate

on:
  workflow_dispatch:
    inputs:
      prefix-keys:
        description: 'Comma-separated prefixes (e.g., CORE-, API-, UI-)'
        required: true
        type: string
      source-branch:
        description: 'Development branch containing new commits'
        required: true
        default: 'main'
      target-branch:
        description: 'Stable branch to rebase onto'
        required: true
        default: 'release'

# Required to push the candidate branch, publish the gh-pages report, and trigger tests
permissions:
  contents: write 
  actions: write

jobs:
  build-candidate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0 

      - name: Build Release Candidate
        uses: brain-lv/build-release-candidate@v1
        with:
          prefix-keys: ${{ github.event.inputs.prefix-keys }}
          source-branch: ${{ github.event.inputs.source-branch }}
          target-branch: ${{ github.event.inputs.target-branch }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
          
          # Optional: Make Jira tickets clickable in the generated HTML report
          key-url: 'https://jira.example.com/browse/{key}'
          
          # Optional: Customize the output branch name
          candidate-branch-name: 'rc/{date}-build-{buildnumber}'