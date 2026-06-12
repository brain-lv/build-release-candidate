import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as fs from 'fs';
import * as crypto from 'crypto';

async function getCommitFiles(hash: string): Promise<string[]> {
    let output = '';
    await exec.exec('git', ['show', '--name-only', '--format=', hash], {
        listeners: { stdout: (data: Buffer) => output += data.toString() },
        silent: true 
    });
    return output.trim().split('\n').filter(Boolean);
}

async function getConflictedFiles(): Promise<string[]> {
    let output = '';
    await exec.exec('git', ['diff', '--name-only', '--diff-filter=U'], {
        listeners: { stdout: (data: Buffer) => output += data.toString() },
        ignoreReturnCode: true,
        silent: true
    });
    return output.trim().split('\n').filter(Boolean);
}

async function remoteBranchExists(branchName: string): Promise<boolean> {
    let output = '';
    await exec.exec('git', ['ls-remote', '--heads', 'origin', branchName], {
        listeners: { stdout: (data: Buffer) => output += data.toString() },
        silent: true
    });
    return output.trim().length > 0;
}

export async function run(): Promise<void> {
    try {
        let prefixKeys = core.getInput('prefix-keys').split(',').map(k => k.trim()).filter(Boolean);
        let suffixKeys = core.getInput('suffix-keys').split(',').map(k => k.trim()).filter(Boolean);
        let regexKeys = core.getInput('regex-keys').split(',').map(k => k.trim()).filter(Boolean);

        const sourceBranch = core.getInput('source-branch');
        const targetBranch = core.getInput('target-branch');
        const token = core.getInput('github-token');
        const testWorkflowId = core.getInput('test-workflow-id');
        const keyUrlTemplate = core.getInput('key-url'); 
        const branchNameTemplate = core.getInput('candidate-branch-name') || 'candidate/{uuid}';

        core.info('Running pre-flight validations...');

        const activeStrategies = [prefixKeys.length > 0, suffixKeys.length > 0, regexKeys.length > 0].filter(Boolean).length;
        if (activeStrategies !== 1) {
            throw new Error("Validation Failed: You must provide EXACTLY ONE of: 'prefix-keys', 'suffix-keys', or 'regex-keys'.");
        }

        if (regexKeys.length > 0) {
            for (const r of regexKeys) {
                try { new RegExp(r); } catch (e) { throw new Error(`Validation Failed: Invalid regex syntax -> ${r}`); }
                
                const hasCapturingGroup = /(?<!\\)\((?!\?:)/.test(r);
                if (!hasCapturingGroup) {
                    throw new Error(`Validation Failed: Regex must contain a standard capturing group '()' or named group '(?<key>...)' to extract the key. Failed pattern: ${r}`);
                }
            }
        }

        if (keyUrlTemplate && !keyUrlTemplate.includes('{key}')) {
            throw new Error("Validation Failed: 'key-url' must contain the '{key}' placeholder (e.g., https://jira.com/browse/{key}).");
        }

        if (!(await remoteBranchExists(sourceBranch))) {
            throw new Error(`Validation Failed: source-branch '${sourceBranch}' does not exist on the remote repository.`);
        }
        if (!(await remoteBranchExists(targetBranch))) {
            throw new Error(`Validation Failed: target-branch '${targetBranch}' does not exist on the remote repository.`);
        }
        
        core.info('✅ All validations passed.');

        const initialPrefixKeys = [...prefixKeys];
        const initialSuffixKeys = [...suffixKeys];
        const initialRegexKeys = [...regexKeys];
        const allInitialKeys = [...initialPrefixKeys, ...initialSuffixKeys, ...initialRegexKeys];
        
        const octokit = github.getOctokit(token);
        const { owner, repo } = github.context.repo;

        await exec.exec('git', ['config', 'user.name', 'github-actions[bot]']);
        await exec.exec('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
        await exec.exec('git', ['fetch', '--all']);

        let mergeBase = '';
        await exec.exec('git', ['merge-base', `origin/${targetBranch}`, `origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => mergeBase += data.toString() }
        });
        mergeBase = mergeBase.trim();

        let logOutput = '';
        
        await exec.exec('git', ['log', '--reverse', '--format=%H|%cn|%ce|%cI|%s', `${mergeBase}..origin/${sourceBranch}`], {
            listeners: { stdout: (data: Buffer) => logOutput += data.toString() }
        });
        
        const commits = logOutput.trim().split('\n').filter(Boolean).map(line => {
            const parts = line.split('|');
            const hash = parts.shift()!;
            const cName = parts.shift()!;
            const cEmail = parts.shift()!;
            const cDate = parts.shift()!;
            const msg = parts.join('|');
            const shortHash = hash.substring(0, 7).toUpperCase(); 
            return { hash, shortHash, cName, cEmail, cDate, msg };
        });

        const runUuid = crypto.randomUUID();
        const dateObj = new Date();
        const dateStr = dateObj.toISOString().split('T')[0];
        const timeStr = dateObj.toTimeString().split(' ')[0].replace(/:/g, '-'); 
        const buildNum = process.env.GITHUB_RUN_NUMBER || '0';

        const candidateBranch = branchNameTemplate
            .replace('{uuid}', runUuid)
            .replace('{date}', dateStr)
            .replace('{time}', timeStr)
            .replace('{buildnumber}', buildNum);
        
        const finalConflicts: any[] = [];
        let finalSummary: any;

        let retryPipeline = true;

        while (retryPipeline) {
            retryPipeline = false;
            let hasPendingChangesToTest = false;

            core.info('========================================');
            core.info(`Starting Pipeline Build. Strategy count: [${allInitialKeys.length}]`);
            core.info('========================================');

            await exec.exec('git', ['checkout', `origin/${targetBranch}`]);
            try { await exec.exec('git', ['branch', '-D', candidateBranch], { silent: true }); } catch (e) {}
            await exec.exec('git', ['checkout', '-b', candidateBranch, `origin/${targetBranch}`]);

            const summary = { applied: [] as any[], skipped: [] as any[], testFailures: [] as any[] };

            for (const commit of commits) {
                const matchedPrefixes = prefixKeys.filter(p => commit.msg.startsWith(p));
                const matchedSuffixes = suffixKeys.filter(s => commit.msg.endsWith(s));
                const matchedRegexes = regexKeys.filter(r => {
                    try { return new RegExp(r).test(commit.msg); } catch(e) { return false; }
                });

                const isMatch = matchedPrefixes.length > 0 || matchedSuffixes.length > 0 || matchedRegexes.length > 0;

                if (isMatch) {
                    core.info(`Applying commit: ${commit.shortHash} (${commit.msg})`);
                    
                    const cherryPickOptions = { 
                        env: { 
                            ...process.env, 
                            GIT_COMMITTER_NAME: commit.cName,
                            GIT_COMMITTER_EMAIL: commit.cEmail,
                            GIT_COMMITTER_DATE: commit.cDate
                        } 
                    };

                    try {
                        await exec.exec('git', ['cherry-pick', commit.hash], cherryPickOptions);
                        summary.applied.push(commit);
                        hasPendingChangesToTest = true;
                    } catch (error) {
                        core.warning(`🚨 Merge conflict on ${commit.shortHash}. Analyzing dependencies and pruning keys...`);
                        
                        const conflictedFiles = await getConflictedFiles();
                        
                        const conflictBranch = `conflict-data/${commit.shortHash}-${runUuid}`;
                        await exec.exec('git', ['cherry-pick', '--abort']);
                        await exec.exec('git', ['checkout', '-b', conflictBranch]);
                        await exec.exec('git', ['cherry-pick', '-n', commit.hash], { ignoreReturnCode: true });
                        await exec.exec('git', ['commit', '-am', `Conflict data for ${commit.hash}`], { ignoreReturnCode: true });
                        await exec.exec('git', ['push', '-u', 'origin', conflictBranch], { ignoreReturnCode: true });
                        
                        const potentialFixes = [];
                        for (const skipped of summary.skipped) {
                            const intersection = skipped.files.filter((f: string) => conflictedFiles.includes(f));
                            const others = skipped.files.filter((f: string) => !conflictedFiles.includes(f));
                            
                            if (intersection.length > 0) {
                                potentialFixes.push({
                                    ...skipped, 
                                    intersectingFiles: intersection,
                                    otherFiles: others
                                });
                            }
                        }

                        const droppedKeys = [...matchedPrefixes, ...matchedSuffixes, ...matchedRegexes];

                        finalConflicts.push({
                            ...commit,
                            files: conflictedFiles,
                            potentialFixes: potentialFixes,
                            droppedKeys: droppedKeys,
                            conflictBranch: conflictBranch 
                        });

                        prefixKeys = prefixKeys.filter(k => !matchedPrefixes.includes(k));
                        suffixKeys = suffixKeys.filter(k => !matchedSuffixes.includes(k));
                        regexKeys = regexKeys.filter(k => !matchedRegexes.includes(k));

                        core.info(`❌ Dropped keys: [${droppedKeys.join(', ')}]. Wiping branch and restarting pipeline...`);
                        
                        retryPipeline = true;
                        break; 
                    }
                } else {
                    core.info(`Skipping commit: ${commit.shortHash} (${commit.msg})`);
                    const files = await getCommitFiles(commit.hash);
                    
                    const matchedInitialPrefixes = initialPrefixKeys.some(p => commit.msg.startsWith(p));
                    const matchedInitialSuffixes = initialSuffixKeys.some(s => commit.msg.endsWith(s));
                    const matchedInitialRegexes = initialRegexKeys.some(r => {
                        try { return new RegExp(r).test(commit.msg); } catch(e) { return false; }
                    });
                    
                    const isPruned = matchedInitialPrefixes || matchedInitialSuffixes || matchedInitialRegexes;
                    const reason = isPruned ? 'Pruned (Merge Conflict)' : 'Ignored (No Match)';

                    summary.skipped.push({ ...commit, files, reason });

                    if (hasPendingChangesToTest && testWorkflowId) {
                        let testPassed = false;
                        core.startGroup(`Automated Validation Loop`);
                        
                        while (!testPassed && summary.applied.length > 0) {
                            const tmpBranch = `build/tmp/${runUuid}`;
                            await exec.exec('git', ['checkout', '-B', tmpBranch]);
                            await exec.exec('git', ['push', '-u', 'origin', tmpBranch, '--force']);

                            let success = false;
                            if (testWorkflowId.endsWith('.yml') || testWorkflowId.endsWith('.yaml')) {
                                await octokit.rest.actions.createWorkflowDispatch({ owner, repo, workflow_id: testWorkflowId, ref: tmpBranch });
                                success = await pollWorkflowRun(octokit, owner, repo, testWorkflowId, tmpBranch);
                            } else {
                                try { await exec.exec(testWorkflowId); success = true; } catch { success = false; }
                            }
                            
                            await exec.exec('git', ['checkout', candidateBranch]);
                            
                            if (success) {
                                testPassed = true;
                                hasPendingChangesToTest = false;
                            } else {
                                const droppedCommit = summary.applied.pop();
                                summary.testFailures.push(droppedCommit);
                                await exec.exec('git', ['reset', '--hard', 'HEAD~1']);
                            }
                        }
                        core.endGroup();
                    } else if (!testWorkflowId) {
                        hasPendingChangesToTest = false;
                    }
                }
            }

            if (!retryPipeline) {
                finalSummary = summary; 
            }
        }

        await exec.exec('git', ['push', '-u', 'origin', candidateBranch]);
        core.setOutput('candidate-branch', candidateBranch);
        
        await publishSummary(finalSummary, finalConflicts, candidateBranch, runUuid, testWorkflowId, allInitialKeys, keyUrlTemplate);

    } catch (error: any) {
        core.setFailed(error.message);
    }
}

async function pollWorkflowRun(octokit: any, owner: string, repo: string, workflowId: string, branch: string): Promise<boolean> {
    const pollDelay = parseInt(process.env.TEST_DELAY_MS || '20000', 10);
    await new Promise(r => setTimeout(r, 15000)); 
    const runs = await octokit.rest.actions.listWorkflowRuns({ owner, repo, workflow_id: workflowId, branch, per_page: 1 });
    if (!runs.data.workflow_runs || runs.data.workflow_runs.length === 0) throw new Error(`Workflow run not found.`);
    const runId = runs.data.workflow_runs[0].id;

    while (true) {
        const { data: runData } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
        if (runData.status === 'completed') return runData.conclusion === 'success';
        await new Promise(r => setTimeout(r, pollDelay));
    }
}

async function publishSummary(summary: any, conflicts: any[], candidateBranch: string, runUuid: string, testWorkflowId: string, initialKeys: string[], keyUrlTemplate: string) {
    const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
    const repository = process.env.GITHUB_REPOSITORY;
    
    const commitBaseUrl = `${serverUrl}/${repository}/commit`;
    const blobBaseUrl = `${serverUrl}/${repository}/blob`;
    const treeBaseUrl = `${serverUrl}/${repository}/tree`;
    
    let lsRemoteOutput = '';
    await exec.exec('git', ['ls-remote', '--heads', 'origin', 'gh-pages'], {
        listeners: { stdout: (data: Buffer) => lsRemoteOutput += data.toString() },
        silent: true
    });

    const hasRemoteGhPages = lsRemoteOutput.trim().length > 0;

    if (hasRemoteGhPages) {
        core.info('Remote gh-pages branch found. Syncing...');
        await exec.exec('git', ['fetch', 'origin', 'gh-pages']);
        try { await exec.exec('git', ['branch', '-D', 'gh-pages'], { silent: true }); } catch (e) {}
        await exec.exec('git', ['checkout', '-b', 'gh-pages', 'origin/gh-pages']);
    } else {
        core.info('Remote gh-pages branch not found. Creating a new orphan branch...');
        await exec.exec('git', ['checkout', '--orphan', 'gh-pages']);
        await exec.exec('git', ['rm', '-rf', '.']);
    }

    let runs: any[] = [];
    if (fs.existsSync('runs.json')) {
        try { runs = JSON.parse(fs.readFileSync('runs.json', 'utf-8')); } 
        catch (e) { core.warning('Failed to read runs.json, starting fresh array.'); }
    }

    runs.unshift({
        uuid: runUuid,
        date: new Date().toISOString(),
        branch: candidateBranch,
        keys: initialKeys,
        applied: summary.applied.length,
        conflicts: conflicts.length,
        failures: summary.testFailures.length
    });

    runs = runs.slice(0, 500);
    fs.writeFileSync('runs.json', JSON.stringify(runs, null, 2));

    const isFullDeploy = conflicts.length === 0 && summary.testFailures.length === 0 && summary.applied.length > 0;
    const isEmpty = summary.applied.length === 0 && conflicts.length === 0 && summary.testFailures.length === 0;

    let deployStatusText = '🔴 FAILED DEPLOY (Cannot Release)';
    let deployStatusClass = 'banner-failed';

    if (isFullDeploy) {
        deployStatusText = '🟢 FULL DEPLOY (Ready for Release)';
        deployStatusClass = 'banner-full';
    } else if (isEmpty) {
        deployStatusText = '⚪ EMPTY RUN (No Matches Found)';
        deployStatusClass = 'banner-empty';
    } else if (summary.applied.length > 0) {
        deployStatusText = '🟠 PARTIAL DEPLOY (Review Required)';
        deployStatusClass = 'banner-partial';
    }

    const formatKeys = (keys: string[]) => {
        if (!keyUrlTemplate) return keys.map(k => `<code>${k}</code>`).join(', ');
        return keys.map(k => `<a href="${keyUrlTemplate.replace('{key}', k)}" target="_blank" class="key-link"><code>${k}</code></a>`).join(', ');
    };

    const mapCommitList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => `<div class="commit-item"><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg}</div>`).join('') 
        : '<div class="empty">None</div>';

    const mapSkippedCommitList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => {
            const badgeClass = c.reason.includes('Ignored') ? 'badge-ignored' : 'badge-conflict';
            return `<div class="commit-item"><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg} <span class="badge ${badgeClass}">${c.reason}</span></div>`;
        }).join('') 
        : '<div class="empty">None</div>';

    const mapFailedTestList = (arr: any[]) => arr.length > 0 
        ? arr.map(c => `<div class="commit-item"><a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg} <span class="badge badge-failed">Validation Failed</span></div>`).join('') 
        : '<div class="empty">None</div>';

    const failedTestsSection = testWorkflowId 
        ? `<h3>❌ Dropped due to Failed Validation Tests</h3>
           <div class="commit-list">${mapFailedTestList(summary.testFailures)}</div>`
        : '';

    const generateConflictGraph = (conflictsArray: any[]) => {
        if (conflictsArray.length === 0) return '<p class="empty" style="margin-left: 40px;">None</p>';
        return conflictsArray.map(c => `
            <div class="conflict-card">
                <div class="commit-header">
                    <strong>🚨 Pipeline Reset - Bad Keys Pruned: ${formatKeys(c.droppedKeys)}</strong>
                    <br>
                    <small>Conflict on: <a href="${commitBaseUrl}/${c.hash}" target="_blank" class="commit-link"><code>${c.shortHash}</code></a> ${c.msg}</small>
                </div>
                <div class="conflict-body">
                    <div class="files-column">
                        <h4>Conflicted Files (Branch View)</h4>
                        <div class="conflict-items">${c.files.map((f: string) => `
                            <div class="commit-item"><a href="${blobBaseUrl}/${c.conflictBranch}/${f}" target="_blank" class="file-link">📄 ${f}</a></div>
                        `).join('')}</div>
                    </div>
                    <div class="fixes-column">
                        <h4>Potential Missing Dependencies (Commit View)</h4>
                        ${c.potentialFixes.length > 0 ? `
                            <div class="conflict-items">${c.potentialFixes.map((fix: any) => `
                                <div class="commit-item" style="margin-bottom: 12px;">
                                    <strong><a href="${commitBaseUrl}/${fix.hash}" target="_blank" class="commit-link"><code>${fix.shortHash}</code></a></strong> ${fix.msg}<br>
                                    <div style="margin-top: 6px;">
                                        <small><strong>Conflicting:</strong> ${fix.intersectingFiles.map((f: string) => `
                                            <a href="${blobBaseUrl}/${fix.hash}/${f}" target="_blank" class="file-link">${f}</a>
                                        `).join(', ')}</small>
                                    </div>
                                </div>
                            `).join('')}</div>
                        ` : `<p class="empty">No skipped commits touched these files.</p>`}
                    </div>
                </div>
            </div>
        `).join('');
    };

    const cssStyles = `
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; max-width: 900px; margin: 40px auto; padding: 0 20px; color: #333; }
        h1 { border-bottom: 2px solid #eaecef; padding-bottom: .3em; margin-bottom: 20px; }
        h2, h3, h4 { color: #0366d6; }
        
        .deploy-banner { padding: 12px 15px; border-radius: 6px; font-weight: bold; margin-bottom: 25px; text-align: center; font-size: 16px; letter-spacing: 0.5px; text-transform: uppercase; }
        .banner-full { background: #dcffe4; color: #1a7f37; border: 1px solid #4ac26b; }
        .banner-partial { background: #fff8c5; color: #9a6700; border: 1px solid #e6cc28; }
        .banner-failed { background: #ffebe9; color: #cf222e; border: 1px solid #ff8182; }
        .banner-empty { background: #f6f8fa; color: #586069; border: 1px solid #e1e4e8; }
        
        .header-meta { background: #f1f8ff; border: 1px solid #c8e1ff; padding: 15px 20px; border-radius: 6px; margin-bottom: 20px; font-size: 14px; }
        .commit-list { background: #f6f8fa; padding: 15px 20px; border-radius: 6px; }
        .commit-item { margin-bottom: 8px; font-family: monospace; font-size: 14px; padding-left: 0; }
        .empty { color: #586069; font-style: italic; }
        
        a { color: #0366d6; text-decoration: none; }
        a:hover { text-decoration: underline; }
        a.commit-link code { color: #0366d6; cursor: pointer; }
        a.commit-link:hover code { text-decoration: underline; color: #005cc5; }
        
        a.key-link code { color: #0366d6; background: #fff; border: 1px solid #c8e1ff; padding: 2px 5px; border-radius: 4px; transition: all 0.2s;}
        a.key-link:hover code { background: #0366d6; color: #fff; text-decoration: none;}
        
        a.file-link { color: #24292e; transition: color 0.2s; }
        a.file-link:hover { text-decoration: underline; color: #0366d6; }
        
        .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; margin-left: 8px; vertical-align: middle; font-family: -apple-system, sans-serif; }
        .badge-ignored { background: #e1e4e8; color: #586069; }
        .badge-conflict { background: #ffdce0; color: #b31d28; }
        .badge-failed { background: #fff5b1; color: #b08800; }
        
        .conflict-card { border: 1px solid #d73a49; border-radius: 6px; margin: 15px 0 15px 0; overflow: hidden; }
        .commit-header { background: #ffeef0; padding: 10px 15px; border-bottom: 1px solid #d73a49; color: #b31d28; font-family: monospace;}
        .commit-header a.commit-link code { color: #b31d28; text-decoration: underline; }
        .conflict-body { display: flex; background: #fff; }
        .files-column, .fixes-column { padding: 15px; flex: 1; }
        .files-column { border-right: 1px solid #eaecef; background: #fdf8f8; }
        .fixes-column { background: #f1f8ff; }
        .conflict-card h4 { margin-top: 0; font-size: 13px; text-transform: uppercase; color: #586069; border-bottom: 1px solid #eaecef; padding-bottom: 5px;}
        .conflict-items { padding-left: 0; margin: 0; }
        .conflict-card small { display: block; color: #586069; margin-top: 2px; font-family: monospace; font-size: 11px;}
        
        .back-btn { display: inline-block; margin-bottom: 20px; font-size: 14px; text-decoration: none; color: #0366d6; }
        
        table { width: 100%; border-collapse: collapse; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.1); border-radius: 6px; overflow: hidden;}
        th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #eaecef; font-size: 14px; vertical-align: top; }
        th { background: #f6f8fa; font-weight: 600; color: #24292e; text-transform: uppercase; font-size: 12px; }
        tr:last-child td { border-bottom: none; }
        tr:hover { background: #fdfdfd; }
        .status-clean { color: #28a745; font-weight: 600; background: #eafeea; padding: 4px 8px; border-radius: 12px; font-size: 12px;}
        .status-warn { color: #b31d28; font-weight: 600; background: #ffeef0; padding: 4px 8px; border-radius: 12px; font-size: 12px;}
        .type-full { color: #1a7f37; font-weight: bold; font-size: 13px; text-transform: uppercase; }
        .type-partial { color: #9a6700; font-weight: bold; font-size: 13px; text-transform: uppercase; }
        .type-failed { color: #cf222e; font-weight: bold; font-size: 13px; text-transform: uppercase; }
        .type-empty { color: #586069; font-weight: bold; font-size: 13px; text-transform: uppercase; }

        @media (prefers-color-scheme: dark) {
            body { background: #0d1117; color: #c9d1d9; }
            h1, h2, h3, h4 { color: #58a6ff; }
            h1 { border-color: #30363d; }
            
            .header-meta, .commit-list, table { background: #161b22; border-color: #30363d; color: #c9d1d9; }
            th { background: #21262d; color: #c9d1d9; }
            tr:hover { background: #21262d; }
            th, td { border-color: #30363d; }
            
            .conflict-body, .fixes-column { background: #0d1117; }
            .files-column { background: #161b22; border-color: #30363d; }
            .conflict-card { border-color: #b31d28; }
            .commit-header { background: #2c0e12; border-bottom: 1px solid #b31d28; color: #ff7b72; }
            .commit-header a.commit-link code { color: #ff7b72; }
            
            a, .back-btn { color: #58a6ff; }
            a.commit-link code { color: #58a6ff; }
            a.file-link { color: #c9d1d9; }
            a.file-link:hover { color: #58a6ff; }
            a.key-link code { background: #21262d; border-color: #30363d; color: #58a6ff; }
            a.key-link:hover code { background: #58a6ff; color: #0d1117; }
            
            .banner-full { background: #135d26; color: #fff; border-color: #2ea043; }
            .banner-partial { background: #9e6a03; color: #fff; border-color: #d29922; }
            .banner-failed { background: #a40e26; color: #fff; border-color: #f85149; }
            .banner-empty { background: #21262d; color: #c9d1d9; border-color: #30363d; }
            
            .status-clean { background: #238636; color: #fff; }
            .status-warn { background: #da3633; color: #fff; }
            
            .badge-ignored { background: #30363d; color: #c9d1d9; }
            .badge-conflict { background: #da3633; color: #fff; }
            
            .type-full { color: #3fb950; }
            .type-partial { color: #d29922; }
            .type-failed { color: #f85149; }
            .type-empty { color: #8b949e; }
        }
    `;

    const reportHtml = `
    <!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Release Candidate Summary</title>
            <style>${cssStyles}</style>
        </head>
        <body>
            <a href="index.html" class="back-btn">← Back to Dashboard</a>
            
            <h1>Release Candidate Summary</h1>
            
            <div class="deploy-banner ${deployStatusClass}">${deployStatusText}</div>
            
            <div class="header-meta">
                <strong>Targeted Keys:</strong> ${formatKeys(initialKeys)}<br>
                <strong style="display:inline-block; margin-top:6px;">Candidate Branch:</strong> <a href="${treeBaseUrl}/${candidateBranch}" target="_blank" style="text-decoration:none;"><code>${candidateBranch}</code></a>
            </div>
            
            <h3>✅ Applied Commits (${summary.applied.length})</h3>
            <div class="commit-list">${mapCommitList(summary.applied)}</div>
            
            <h3>⏭️ Skipped Commits</h3>
            <div class="commit-list">${mapSkippedCommitList(summary.skipped)}</div>
            
            <h3>⚠️ Invalidated Tickets (Merge Conflicts)</h3>
            ${generateConflictGraph(conflicts)}
            
            ${failedTestsSection}
        </body>
    </html>`;

    const dashboardHtml = `
    <!DOCTYPE html>
    <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Release Candidate Summary</title>
            <style>${cssStyles}</style>
        </head>
        <body style="max-width: 1100px;">
            <h1>Release Candidate Summary</h1>
            <table>
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>Targeted Keys</th>
                        <th>Branch</th>
                        <th>Deploy Status</th>
                        <th>Report</th>
                    </tr>
                </thead>
                <tbody>
                    ${runs.map(r => {
                        let deployType = '<span class="type-failed">Failed Deploy</span>';
                        if (r.conflicts === 0 && r.failures === 0 && r.applied > 0) deployType = '<span class="type-full">Full Deploy</span>';
                        else if (r.applied === 0 && r.conflicts === 0 && r.failures === 0) deployType = '<span class="type-empty">Empty Run</span>';
                        else if (r.applied > 0) deployType = '<span class="type-partial">Partial Deploy</span>';

                        return `
                        <tr>
                            <td style="white-space: nowrap;">${new Date(r.date).toLocaleDateString()} ${new Date(r.date).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
                            <td style="max-width: 300px; line-height: 1.8;">${formatKeys(r.keys)}</td>
                            <td><a href="${treeBaseUrl}/${r.branch}" target="_blank" style="text-decoration:none;"><code>${r.branch.replace('candidate/', '')}</code></a></td>
                            <td>
                                <div style="margin-bottom: 6px;">${deployType}</div>
                                ${r.conflicts > 0 || r.failures > 0 
                                    ? `<span class="status-warn">${r.conflicts} Conflicts, ${r.failures} Fails</span>` 
                                    : `<span class="status-clean">✅ Clean (${r.applied})</span>`}
                            </td>
                            <td><strong><a href="report-${r.uuid}.html">View Details →</a></strong></td>
                        </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        </body>
    </html>`;

    fs.writeFileSync('runs.json', JSON.stringify(runs, null, 2));
    fs.writeFileSync(`report-${runUuid}.html`, reportHtml);
    fs.writeFileSync('index.html', dashboardHtml);
    
    await exec.exec('git', ['add', `report-${runUuid}.html`, 'index.html', 'runs.json']);
    await exec.exec('git', ['commit', '-m', `Add automation report for ${candidateBranch}`]);
    await exec.exec('git', ['push', 'origin', 'gh-pages']);

    await exec.exec('git', ['checkout', candidateBranch]);
    
}
