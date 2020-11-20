const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const util = require('util');
const tmp = require('tmp');
const { spawn } = require('child_process');
const os = require('os');
const {
  addAccountOptions,
  addConfigOptions,
  setLogLevel,
  getAccountId,
  addUseEnvironmentOptions,
} = require('../../lib/commonOpts');
const { trackCommandUsage } = require('../../lib/usageTracking');
const { logDebugInfo } = require('../../lib/debugInfo');
const {
  loadConfig,
  validateConfig,
  checkAndWarnGitInclusion,
} = require('@hubspot/cms-lib');
const { logger } = require('@hubspot/cms-lib/logger');
const { handleExit } = require('@hubspot/cms-lib/lib/process');
const { validateAccount } = require('../../lib/validation');
const defaultFunctionPackageJson = require('../../lib/templates/default-function-package.json');

/* TODO
  - Move files to temp dir and perform actions there to prevent messing with original files
  - Make sure the shape of dataForFunc mimics shape of data passed in first param in cloud functions
  - Determine how to properly limit the secrets/environment variables that are accessible
    - Add limitations of vars that cannot be used due to AWS (see https://github.com/vercel/fun/blob/master/src/index.ts#L33-L51)
  - Figure out timeout limit (AWS default 3s, max 900s) and how to indicate if function exceeds time limit
  - userIsLoggedIn -- visitorId etc that gets passed in, how can we mimic?
  -- Warn if too many deps are found in package.json
*/

const loadAndValidateOptions = async options => {
  setLogLevel(options);
  logDebugInfo(options);
  const { config: configPath } = options;
  loadConfig(configPath, options);
  checkAndWarnGitInclusion();

  if (!(validateConfig() && (await validateAccount(options)))) {
    process.exit(1);
  }
};

const installDeps = folderPath => {
  const npmCmd = os.platform().startsWith('win') ? 'npm.cmd' : 'npm';
  const packageJsonExists = fs.existsSync(`${folderPath}/package.json`);

  if (!packageJsonExists) {
    logger.debug(`No package.json found: using default dependencies.`);
    fs.writeFileSync(
      `${folderPath}/package.json`,
      JSON.stringify(defaultFunctionPackageJson)
    );
  }

  logger.debug(`Installing dependencies from ${folderPath}/package.json`);

  return new Promise((resolve, reject) => {
    try {
      const npmInstallProcess = spawn(npmCmd, ['i'], {
        env: process.env,
        cwd: folderPath,
        stdio: 'inherit',
      });

      npmInstallProcess.on('exit', data => {
        resolve(data);
      });
    } catch (e) {
      reject(e);
    }
  });
};

const cleanupArtifacts = folderPath => {
  if (fs.existsSync(folderPath)) {
    logger.debug(`Cleaning up artifacts: ${folderPath}.`);
    fs.rmdirSync(folderPath, { recursive: true });
  }
};

const loadEnvVars = folderPath => {
  const dotEnvPathMaybe = `${folderPath}/.env`;

  if (fs.existsSync(dotEnvPathMaybe)) {
    const loadedConfig = require('dotenv').config({ path: dotEnvPathMaybe });
    logger.debug(`Loaded .env config from ${dotEnvPathMaybe}.`);
    return loadedConfig;
  }

  return {};
};

const addEndpointToApp = (
  app,
  method,
  route,
  functionPath,
  file,
  accountId,
  globalEnvironment,
  localEnvironment
) => {
  app[method.toLowerCase()](`/${route}`, async (req, res) => {
    const functionFilePath = path.resolve(`${functionPath}/${file}`);
    if (!fs.existsSync(functionFilePath)) {
      logger.error(`Could not find file ${functionPath}/${file}.`);
      return;
    }
    const { main } = require(functionFilePath);

    if (!main) {
      logger.error(`Could not find "main" export in ${functionPath}/${file}.`);
    }

    const config = await loadEnvVars(functionPath);

    if (config.error) {
      throw config.error;
    }

    const { parsed } = config;

    try {
      const dataForFunc = {
        ...globalEnvironment,
        ...localEnvironment,
        accountId,
        ...req,
        ...parsed,
      };

      await main(dataForFunc, sendResponseValue => {
        res.json(sendResponseValue);
      });
    } catch (e) {
      res.json(e);
    }
  });
};

const getValidatedFunctionData = functionPath => {
  if (!fs.existsSync(functionPath)) {
    logger.error(`The path ${functionPath} does not exist.`);
    return;
  } else {
    const stats = fs.lstatSync(functionPath);
    if (!stats.isDirectory()) {
      logger.error(`${functionPath} is not a valid functions directory.`);
      return;
    }
  }

  const { endpoints, environment } = JSON.parse(
    fs.readFileSync(`${functionPath}/serverless.json`, {
      encoding: 'utf-8',
    })
  );
  const routes = Object.keys(endpoints);

  if (!routes.length) {
    logger.error(`No endpoints found in ${functionPath}/serverless.json.`);
    return;
  }

  return {
    srcPath: functionPath,
    endpoints,
    environment,
    routes,
  };
};

const initializeFunction = async functionData => {
  const tmpDir = tmp.dirSync();

  logger.debug(`Created temporary function test folder: ${tmpDir.name}`);

  await fs.copy(functionData.srcPath, tmpDir.name, {
    overwrite: false,
    errorOnExist: true,
  });

  await installDeps(tmpDir.name);

  handleExit(() => {
    cleanupArtifacts(tmpDir.name);
  });

  return {
    ...functionData,
    testPath: tmpDir.name,
  };
};

const runTestServer = async (port, accountId, functionPath) => {
  const validatedFunctionData = getValidatedFunctionData(functionPath);

  if (!validatedFunctionData) {
    process.exit();
  }

  const {
    endpoints,
    routes,
    environment: globalEnvironment,
    testPath,
  } = await initializeFunction(validatedFunctionData);

  const app = express();

  routes.forEach(route => {
    const { method, file, environment: localEnvironment } = endpoints[route];

    if (Array.isArray(method)) {
      method.forEach(methodType => {
        addEndpointToApp(
          app,
          methodType,
          route,
          testPath,
          file,
          accountId,
          globalEnvironment,
          localEnvironment
        );
      });
    } else {
      addEndpointToApp(
        app,
        method,
        route,
        testPath,
        file,
        accountId,
        globalEnvironment,
        localEnvironment
      );
    }
  });

  app.listen(port, () => {
    console.log(
      `Local function test server running at http://localhost:${port}`
    );
    console.log(
      'Endpoints: ',
      util.inspect(endpoints, {
        colors: true,
        compact: true,
        depth: 'Infinity',
      })
    );
  });
};

exports.command = 'test <path>';
exports.describe = false;

exports.handler = async options => {
  loadAndValidateOptions(options);

  const { path: functionPath, port } = options;
  const accountId = getAccountId(options);

  trackCommandUsage('functions-test', { functionPath }, accountId);

  const splitFunctionPath = functionPath.split('.');

  if (
    !splitFunctionPath.length ||
    splitFunctionPath[splitFunctionPath.length - 1] !== 'functions'
  ) {
    logger.error(`Specified path ${functionPath} is not a .functions folder.`);
    return;
  }

  logger.debug(
    `Starting test server for .functions folder with path: ${functionPath}`
  );

  try {
    await runTestServer(port, accountId, functionPath);
  } catch (e) {
    console.log('============ ERROR ===============');
    console.log(e);
  }
};

exports.builder = yargs => {
  yargs.positional('path', {
    describe: 'Path to local .functions folder',
    type: 'string',
  });
  yargs.option('port', {
    describe: 'port to run the test server on',
    type: 'string',
    default: 5432,
  });
  yargs.example([
    [
      '$0 functions test ./tmp/myFunctionFolder.functions',
      'Run a local function test server.',
    ],
  ]);

  addConfigOptions(yargs, true);
  addAccountOptions(yargs, true);
  addUseEnvironmentOptions(yargs, true);

  return yargs;
};