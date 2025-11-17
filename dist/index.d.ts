import { z } from 'zod';

type ToolContext = {
    /**
     * Raw headers from the incoming request. Useful if contributors need to
     * inspect authentication or tracing metadata.
     */
    headers?: Record<string, string | string[] | undefined>;
};
type DefineHttpToolOptions<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
    name: string;
    version?: string;
    description?: string;
    inputSchema: I;
    outputSchema: O;
    handler: (input: z.infer<I>, context: ToolContext) => Promise<z.infer<O>>;
};
type HttpToolDefinition<I extends z.ZodTypeAny, O extends z.ZodTypeAny> = {
    name: string;
    version?: string;
    description?: string;
    inputSchema: I;
    outputSchema: O;
    handler: (input: z.infer<I>, context: ToolContext) => Promise<z.infer<O>>;
};
type ExecuteHttpToolOptions = {
    headers?: Record<string, string | string[] | undefined>;
};
type ContextResponse<T> = {
    data: T;
    meta: {
        tool: string;
        version?: string;
        generatedAt: string;
    };
};
declare function defineHttpTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(options: DefineHttpToolOptions<I, O>): HttpToolDefinition<I, O>;
declare function executeHttpTool<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(tool: HttpToolDefinition<I, O>, input: unknown, options?: ExecuteHttpToolOptions): Promise<ContextResponse<z.infer<O>>>;

export { type ContextResponse, type DefineHttpToolOptions, type ExecuteHttpToolOptions, type HttpToolDefinition, type ToolContext, defineHttpTool, executeHttpTool };
