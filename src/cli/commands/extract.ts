import { CommandOptions } from '../parser';
import { ConsoleLogger } from '../logger';

export const cliDefinition = {
  description: 'Extract GraphQL documents from TypeScript sources.',
  options: {
    project: {
      alias: 'p',
      description:
        "Analyze the project given the path to its configuration file, or to a folder with a 'tsconfig.json'.",
      defaultValue: '.',
      type: 'string',
    },
    outFile: {
      alias: 'o',
      description: 'Output file name of manifest.',
      defaultValue: 'manifest.json',
      type: 'string',
    },
    verbose: {
      description: 'Show debug messages.',
      type: 'boolean',
    },
  },
} as const;

export async function extractCommand({ options }: CommandOptions<typeof cliDefinition>) {
  const ts = require('typescript') as typeof import('typescript');
  const {
    AnalyzerFactory,
  } = require('../../analyzer/analyzer-factory') as typeof import('../../analyzer/analyzer-factory');
  const { ErrorReporter } = require('../error-reporter') as typeof import('../error-reporter');
  const { color } = require('../../string-util') as typeof import('../../string-util');

  const logger = new ConsoleLogger(options.verbose ? 'debug' : 'info');
  const errorReporter = new ErrorReporter(process.cwd(), logger.error.bind(logger));

  const { project, outFile } = options;
  const analyzer = new AnalyzerFactory().createAnalyzerFromProjectPath(project);
  const [errors, manifest] = analyzer.extract();

  if (errors.length) {
    logger.error(color.magenta('Found some errors extracting operations.\n'));
    errors.forEach(error => errorReporter.indicateErrorWithLocation(error));
  }
  ts.sys.writeFile(outFile, JSON.stringify(manifest, null, 2));
  logger.info(`Write manifest file to '${color.green(outFile)}'.`);
  return true;
}
