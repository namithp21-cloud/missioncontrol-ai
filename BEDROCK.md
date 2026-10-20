# Amazon Bedrock Integration — MissionControl AI

MissionControl AI integrates **Amazon Bedrock Runtime** (`@aws-sdk/client-bedrock-runtime`) as an enterprise LLM provider option for the Amazon Developer Hackathon.

## Architecture
- **Provider Abstraction:** The backend communicates via the `LLMProvider` interface (`server/agent/providers.ts`). Switching to Bedrock requires only setting `LLM_PROVIDER=bedrock`.
- **Converse API:** Leverages `@aws-sdk/client-bedrock-runtime` and `ConverseCommand` to handle structured system prompts, multi-turn messages, and tool definitions natively across Bedrock foundation models (e.g., Anthropic Claude 3.5 Sonnet).
- **Graceful Fallback:** If AWS credentials are absent or invalid, the platform automatically falls back to the deterministic local scenario engine in clearly labeled Demo Mode.

## Setup & Configuration
Add the following variables to your `.env` file:
```env
LLM_PROVIDER=bedrock
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
LLM_MODEL=anthropic.claude-3-5-sonnet-20241022-v1:0