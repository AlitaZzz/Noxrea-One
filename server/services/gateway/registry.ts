/**
 * Gateway 注册中心。
 * 维护能力（Capability）与协议（Protocol）的注册表，
 * 并在导入副作用中触发各能力实现的注册。
 */

import { registerProtocol } from "@server/services/protocols/base";
import { logEvent } from "@server/core/logger/utils";

import "@server/services/capabilities/image/service";
import "@server/services/capabilities/video/service";
import "@server/services/capabilities/llm/service";
import "@server/services/capabilities/audio/service";

// 导入 Protocol 实现
import { OpenAiImageProtocol } from "@server/services/protocols/openai/image";
import { OpenAiVideoProtocol } from "@server/services/protocols/openai/video";
import { OpenAiLlmProtocol } from "@server/services/protocols/openai/llm";
import { OpenAiAudioProtocol } from "@server/services/protocols/openai/audio";
import { GeminiImageProtocol } from "@server/services/protocols/gemini/image";
import { GeminiLlmProtocol } from "@server/services/protocols/gemini/llm";
import { ArkImageProtocol } from "@server/services/protocols/ark/image";
import { ArkVideoProtocol } from "@server/services/protocols/ark/video";

let initialized = false;

/**
 * 幂等初始化：注册所有 Capability 和 Protocol 实现
 */
export function initGateway(): void {
  if (initialized) return;
  initialized = true;

  // 注册 Protocols
  // OpenAI
  const openaiImage = new OpenAiImageProtocol();
  const openaiVideo = new OpenAiVideoProtocol();
  const openaiLlm = new OpenAiLlmProtocol();
  const openaiAudio = new OpenAiAudioProtocol();

  registerProtocol("openai", {
    name: "openai",
    buildImageRequest: openaiImage.buildImageRequest.bind(openaiImage),
    parseImageResponse: openaiImage.parseImageResponse.bind(openaiImage),
    extractTaskId: openaiImage.extractTaskId.bind(openaiImage),
    buildPollUrl: openaiImage.buildPollUrl.bind(openaiImage),
    parsePollResponse: openaiImage.parsePollResponse.bind(openaiImage),
    buildVideoRequest: openaiVideo.buildVideoRequest.bind(openaiVideo),
    parseVideoResponse: openaiVideo.parseVideoResponse.bind(openaiVideo),
    buildLlmRequest: openaiLlm.buildLlmRequest.bind(openaiLlm),
    parseLlmResponse: openaiLlm.parseLlmResponse.bind(openaiLlm),
    buildAudioRequest: openaiAudio.buildAudioRequest.bind(openaiAudio),
    parseAudioResponse: openaiAudio.parseAudioResponse.bind(openaiAudio),
  });

  // Gemini
  const geminiImage = new GeminiImageProtocol();
  const geminiLlm = new GeminiLlmProtocol();
  registerProtocol("gemini", {
    name: "gemini",
    buildImageRequest: geminiImage.buildImageRequest.bind(geminiImage),
    parseImageResponse: geminiImage.parseImageResponse.bind(geminiImage),
    buildLlmRequest: geminiLlm.buildLlmRequest.bind(geminiLlm),
    parseLlmResponse: geminiLlm.parseLlmResponse.bind(geminiLlm),
  });

  // Ark
  const arkImage = new ArkImageProtocol();
  const arkVideo = new ArkVideoProtocol();
  registerProtocol("ark", {
    name: "ark",
    buildImageRequest: arkImage.buildImageRequest.bind(arkImage),
    parseImageResponse: arkImage.parseImageResponse.bind(arkImage),
    buildVideoRequest: arkVideo.buildVideoRequest.bind(arkVideo),
    parseVideoResponse: arkVideo.parseVideoResponse.bind(arkVideo),
  });

  logEvent("gateway.registry", { stage: "protocols_registered" });
}
