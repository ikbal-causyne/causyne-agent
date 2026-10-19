import { canonicalModelId } from '../modelIds.js';
import { DEFAULT_MODEL_BY_PROVIDER } from '../modelCatalogue.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(config) {
    super(config);
    this.baseUrl = 'https://api.openai.com/v1/chat/completions';
    this.model = canonicalModelId(config.model || DEFAULT_MODEL_BY_PROVIDER['openai']);
    this.visionModels = ['*'];
    this.imagePayloadFormat = 'openai';
    // Vision is '*' but audio is emphatically NOT. OpenAI accepts input_audio
    // only on the audio-capable families; the text models reject the block
    // outright, so copying visionModels here would 400 on every ordinary chat
    // model. Audio input is also limited to wav and mp3 containers, which is
    
    this.audioModels = ['gpt-4o-audio', 'gpt-4o-mini-audio', 'gpt-audio', 'gpt-realtime'];
    this.audioPayloadFormat = 'openai';
  }
}
