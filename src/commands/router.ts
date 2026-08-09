import type { AgentService } from '../agent/agentService.js';
import type { Logger } from '../utils/logger.js';
import { parseCommand, type ParsedCommand } from './parser.js';
import { formatUnknownCommand } from '../messaging/formatter.js';
import {
  handleAdd,
  handleAdvance,
  handleDone,
  handleHelp,
  handleMath,
  handleMathAnswer,
  handleRescue,
  handleSnooze,
  handleStatus,
  handleStuck,
  handleToday,
  handleWhatNow,
  type HandlerDeps,
} from './handlers.js';

export interface RouteResult {
  reply: string;
  command: ParsedCommand;
}

export interface CommandRouterDeps {
  agent: AgentService;
  logger: Logger;
}

/**
 * Turns a line of text into a reply.
 *
 * Nothing here can execute anything: commands map to a fixed set of handler
 * functions, and unrecognised input falls through to a help hint. There is no
 * dynamic dispatch on user text, no shell, and no eval anywhere in the path.
 */
export class CommandRouter {
  constructor(private readonly deps: CommandRouterDeps) {}

  async route(text: string): Promise<RouteResult> {
    const command = parseCommand(text);
    const agent = this.deps.agent;
    const context = await agent.buildContext();
    const handlerDeps: HandlerDeps = { agent, context };

    // An outstanding math question turns any un-command-like reply into an
    // answer, so the user can just type "3" without a keyword.
    if (command.name === 'unknown' || command.name === 'answer') {
      const pending = agent.mathService.pendingQuestion();
      if (pending) {
        const reply = await handleMathAnswer(handlerDeps, command.raw);
        if (reply !== null) {
          return { reply, command: { ...command, name: 'answer' } };
        }
      }
    }

    const reply = await this.dispatch(command, handlerDeps);

    await agent.logEvent('command', {
      command: command.name,
      details: command.raw.slice(0, 120),
      result: 'ok',
    });

    return { reply, command };
  }

  private async dispatch(command: ParsedCommand, deps: HandlerDeps): Promise<string> {
    try {
      switch (command.name) {
        case 'today':
          return await handleToday(deps);
        case 'what_now':
          return await handleWhatNow(deps);
        case 'done':
          return await handleDone(deps);
        case 'stuck':
          return await handleStuck(deps);
        case 'advance':
          return await handleAdvance(deps);
        case 'snooze':
          return await handleSnooze(deps, command.argument);
        case 'rescue':
          return await handleRescue(deps);
        case 'add':
          return await handleAdd(deps, command.argument);
        case 'math':
          return await handleMath(deps);
        case 'status':
          return await handleStatus(deps);
        case 'help':
          return handleHelp();
        default:
          return formatUnknownCommand();
      }
    } catch (error) {
      // A handler failure must still produce a usable reply — silence would
      // leave the user staring at a phone wondering if the agent is alive.
      this.deps.logger.error(
        {
          command: command.name,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        'command handler failed',
      );
      return 'Something broke on my end. Try again, or reply HELP.';
    }
  }
}
