import { z } from "zod";

export type ToolContext = {
  /**
   * Raw headers from the incoming request. Useful if contributors need to
   * inspect authentication or tracing metadata.
   */
  headers?: Record<string, string | string[] | undefined>;
};

export type DefineHttpToolOptions<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  name: string;
  version?: string;
  description?: string;
  inputSchema: I;
  outputSchema: O;
  handler: (input: z.infer<I>, context: ToolContext) => Promise<z.infer<O>>;
};

export type HttpToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
  name: string;
  version?: string;
  description?: string;
  inputSchema: I;
  outputSchema: O;
  handler: (input: z.infer<I>, context: ToolContext) => Promise<z.infer<O>>;
};

export type ExecuteHttpToolOptions = {
  headers?: Record<string, string | string[] | undefined>;
};

export type ContextResponse<T> = {
  data: T;
  meta: {
    tool: string;
    version?: string;
    generatedAt: string;
  };
};

export function defineHttpTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  options: DefineHttpToolOptions<I, O>
): HttpToolDefinition<I, O> {
  return options;
}

export async function executeHttpTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  tool: HttpToolDefinition<I, O>,
  input: unknown,
  options: ExecuteHttpToolOptions = {}
): Promise<ContextResponse<z.infer<O>>> {
  const parsedInput = tool.inputSchema.parse(input);

  const data = await tool.handler(parsedInput, {
    headers: options.headers,
  });

  const parsedOutput = tool.outputSchema.parse(data);

  return {
    data: parsedOutput,
    meta: {
      tool: tool.name,
      version: tool.version,
      generatedAt: new Date().toISOString(),
    },
  };
}

