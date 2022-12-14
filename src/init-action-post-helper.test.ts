import test, { ExecutionContext } from "ava";
import * as sinon from "sinon";

import * as actionsUtil from "./actions-util";
import * as codeql from "./codeql";
import * as configUtils from "./config-utils";
import { Feature } from "./feature-flags";
import * as initActionPostHelper from "./init-action-post-helper";
import { getRunnerLogger } from "./logging";
import { parseRepositoryNwo } from "./repository";
import {
  createFeatures,
  getRecordingLogger,
  LoggedMessage,
  setupTests,
} from "./testing-utils";
import * as uploadLib from "./upload-lib";
import * as util from "./util";
import * as workflow from "./workflow";

setupTests(test);

test("post: init action with debug mode off", async (t) => {
  return await util.withTmpDir(async (tmpDir) => {
    process.env["GITHUB_REPOSITORY"] = "github/codeql-action-fake-repository";
    process.env["RUNNER_TEMP"] = tmpDir;

    const gitHubVersion: util.GitHubVersion = {
      type: util.GitHubVariant.DOTCOM,
    };
    sinon.stub(configUtils, "getConfig").resolves({
      debugMode: false,
      gitHubVersion,
      languages: [],
      packs: [],
    } as unknown as configUtils.Config);

    const uploadDatabaseBundleSpy = sinon.spy();
    const uploadLogsSpy = sinon.spy();
    const printDebugLogsSpy = sinon.spy();

    await initActionPostHelper.run(
      uploadDatabaseBundleSpy,
      uploadLogsSpy,
      printDebugLogsSpy,
      parseRepositoryNwo("github/codeql-action"),
      createFeatures([]),
      getRunnerLogger(true)
    );

    t.assert(uploadDatabaseBundleSpy.notCalled);
    t.assert(uploadLogsSpy.notCalled);
    t.assert(printDebugLogsSpy.notCalled);
  });
});

test("post: init action with debug mode on", async (t) => {
  return await util.withTmpDir(async (tmpDir) => {
    process.env["GITHUB_REPOSITORY"] = "github/codeql-action-fake-repository";
    process.env["RUNNER_TEMP"] = tmpDir;

    const gitHubVersion: util.GitHubVersion = {
      type: util.GitHubVariant.DOTCOM,
    };
    sinon.stub(configUtils, "getConfig").resolves({
      debugMode: true,
      gitHubVersion,
      languages: [],
      packs: [],
    } as unknown as configUtils.Config);

    const uploadDatabaseBundleSpy = sinon.spy();
    const uploadLogsSpy = sinon.spy();
    const printDebugLogsSpy = sinon.spy();

    await initActionPostHelper.run(
      uploadDatabaseBundleSpy,
      uploadLogsSpy,
      printDebugLogsSpy,
      parseRepositoryNwo("github/codeql-action"),
      createFeatures([]),
      getRunnerLogger(true)
    );

    t.assert(uploadDatabaseBundleSpy.called);
    t.assert(uploadLogsSpy.called);
    t.assert(printDebugLogsSpy.called);
  });
});

test("uploads failed SARIF run for typical workflow", async (t) => {
  const actionsWorkflow = createTestWorkflow([
    {
      name: "Checkout repository",
      uses: "actions/checkout@v3",
    },
    {
      name: "Initialize CodeQL",
      uses: "github/codeql-action/init@v2",
      with: {
        languages: "javascript",
      },
    },
    {
      name: "Perform CodeQL Analysis",
      uses: "github/codeql-action/analyze@v2",
      with: {
        category: "my-category",
      },
    },
  ]);
  await testFailedSarifUpload(t, actionsWorkflow, { category: "my-category" });
});

test("doesn't upload failed SARIF for workflow with upload: false", async (t) => {
  const actionsWorkflow = createTestWorkflow([
    {
      name: "Checkout repository",
      uses: "actions/checkout@v3",
    },
    {
      name: "Initialize CodeQL",
      uses: "github/codeql-action/init@v2",
      with: {
        languages: "javascript",
      },
    },
    {
      name: "Perform CodeQL Analysis",
      uses: "github/codeql-action/analyze@v2",
      with: {
        category: "my-category",
        upload: false,
      },
    },
  ]);
  await testFailedSarifUpload(t, actionsWorkflow, {
    expectedLogs: [
      {
        message:
          "Won't upload a failed SARIF file since SARIF upload is disabled.",
        type: "debug",
      },
    ],
    expectUpload: false,
  });
});

test("uploading failed SARIF run fails when workflow does not reference github/codeql-action", async (t) => {
  const actionsWorkflow = createTestWorkflow([
    {
      name: "Checkout repository",
      uses: "actions/checkout@v3",
    },
  ]);
  await t.throwsAsync(
    async () => await testFailedSarifUpload(t, actionsWorkflow)
  );
});

function createTestWorkflow(
  steps: workflow.WorkflowJobStep[]
): workflow.Workflow {
  return {
    name: "CodeQL",
    on: {
      push: {
        branches: ["main"],
      },
      pull_request: {
        branches: ["main"],
      },
    },
    jobs: {
      analyze: {
        name: "CodeQL Analysis",
        "runs-on": "ubuntu-latest",
        steps,
      },
    },
  };
}

async function testFailedSarifUpload(
  t: ExecutionContext<unknown>,
  actionsWorkflow: workflow.Workflow,
  {
    category,
    expectedLogs = [],
    expectUpload = true,
  }: {
    category?: string;
    expectedLogs?: LoggedMessage[];
    expectUpload?: boolean;
  } = {}
): Promise<void> {
  const config = {
    codeQLCmd: "codeql",
    debugMode: true,
    languages: [],
    packs: [],
  } as unknown as configUtils.Config;
  const messages = [];
  process.env["GITHUB_JOB"] = "analyze";
  process.env["GITHUB_REPOSITORY"] = "github/codeql-action-fake-repository";
  process.env["GITHUB_WORKSPACE"] =
    "/home/runner/work/codeql-action/codeql-action";
  sinon.stub(actionsUtil, "getRequiredInput").withArgs("matrix").returns("{}");

  const codeqlObject = await codeql.getCodeQLForTesting();
  sinon.stub(codeql, "getCodeQL").resolves(codeqlObject);
  const diagnosticsExportStub = sinon.stub(codeqlObject, "diagnosticsExport");

  sinon.stub(workflow, "getWorkflow").resolves(actionsWorkflow);

  const uploadFromActions = sinon.stub(uploadLib, "uploadFromActions");
  uploadFromActions.resolves({ sarifID: "42" } as uploadLib.UploadResult);
  const waitForProcessing = sinon.stub(uploadLib, "waitForProcessing");

  await initActionPostHelper.uploadFailedSarif(
    config,
    parseRepositoryNwo("github/codeql-action"),
    createFeatures([Feature.UploadFailedSarifEnabled]),
    getRecordingLogger(messages)
  );
  t.deepEqual(messages, expectedLogs);
  if (expectUpload) {
    t.true(
      diagnosticsExportStub.calledOnceWith(sinon.match.string, category),
      `Actual args were: ${diagnosticsExportStub.args}`
    );
    t.true(
      uploadFromActions.calledOnceWith(
        sinon.match.string,
        sinon.match.string,
        category,
        sinon.match.any
      ),
      `Actual args were: ${uploadFromActions.args}`
    );
    t.true(
      waitForProcessing.calledOnceWith(sinon.match.any, "42", sinon.match.any, {
        isUnsuccessfulExecution: true,
      })
    );
  } else {
    t.true(diagnosticsExportStub.notCalled);
    t.true(uploadFromActions.notCalled);
    t.true(waitForProcessing.notCalled);
  }
}
