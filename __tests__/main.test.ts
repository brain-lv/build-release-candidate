import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as github from '@actions/github';
import { run } from '../src/main';

// 1. Mock the GitHub Actions Toolkit
jest.mock('@actions/core');
jest.mock('@actions/exec');
jest.mock('@actions/github');

describe('Smart Jira Rebaser Action', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        // Mock GitHub Context
        Object.defineProperty(github, 'context', {
            value: {
                repo: { owner: 'test-owner', repo: 'test-repo' }
            }
        });

        // Mock Inputs
        (core.getInput as jest.Mock).mockImplementation((name: string) => {
            switch (name) {
                case 'jira-keys': return 'KEY-1, KEY-2';
                case 'source-branch': return 'feature-branch';
                case 'target-branch': return 'main';
                case 'github-token': return 'fake-token';
                case 'test-workflow-id': return 'test.yml';
                default: return '';
            }
        });

        // Mock Octokit
        (github.getOctokit as jest.Mock).mockReturnValue({
            rest: {
                actions: {
                    createWorkflowDispatch: jest.fn(),
                    listWorkflowRuns: jest.fn(),
                    getWorkflowRun: jest.fn()
                }
            }
        });
    });

    it('should cherry-pick commits containing Jira keys and skip others', async () => {
        // Mock the exec commands, specifically the git log output
        (exec.exec as jest.Mock).mockImplementation(async (cmd: string, args: string[], options: any) => {
            if (cmd === 'git' && args.includes('log')) {
                // Simulate Git Log Output: One matching commit, one skipped
                const mockGitLog = "hash1|Mon, 1 Jan 2024|KEY-1: Fix login\nhash2|Tue, 2 Jan 2024|Refactor CSS (no key)\n";
                if (options && options.listeners && options.listeners.stdout) {
                    options.listeners.stdout(Buffer.from(mockGitLog));
                }
                return 0;
            }
            // By default, assume all git commands succeed (no merge conflicts)
            return 0; 
        });

        await run();

        // Assertions
        expect(core.setFailed).not.toHaveBeenCalled();
        
        // Verify we attempted to cherry-pick hash1 (because it has KEY-1)
        expect(exec.exec).toHaveBeenCalledWith(
            'git', 
            ['cherry-pick', 'hash1'], 
            expect.objectContaining({
                env: expect.objectContaining({ GIT_COMMITTER_DATE: 'Mon, 1 Jan 2024' })
            })
        );

        // Verify we DID NOT attempt to cherry pick hash2
        expect(exec.exec).not.toHaveBeenCalledWith(
            'git', 
            ['cherry-pick', 'hash2'], 
            expect.anything()
        );

        // Verify logging output
        expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Applying commit: hash1'));
        expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Skipping commit: hash2'));
    });

    it('should catch merge conflicts and abort cherry-pick', async () => {
        (exec.exec as jest.Mock).mockImplementation(async (cmd: string, args: string[], options: any) => {
            if (cmd === 'git' && args.includes('log')) {
                const mockGitLog = "hash1|Mon, 1 Jan 2024|KEY-1: Conflict commit\n";
                if (options && options.listeners && options.listeners.stdout) {
                    options.listeners.stdout(Buffer.from(mockGitLog));
                }
                return 0;
            }
            
            // Simulate a merge conflict specifically on the cherry-pick command
            if (cmd === 'git' && args.includes('cherry-pick') && args.includes('hash1')) {
                throw new Error('Merge conflict');
            }
            return 0;
        });

        await run();

        // Verify conflict handling logic was triggered
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Merge conflict on hash1'));
        expect(exec.exec).toHaveBeenCalledWith('git', ['cherry-pick', '--abort']);
    });
});