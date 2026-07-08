import TextRecognition, {
  TextRecognitionScript,
} from '@react-native-ml-kit/text-recognition';

import type { OcrLine } from '@/domain/receiptParse';

/**
 * 온디바이스 영수증 문자 인식 (Google ML Kit).
 * 서버·API 키 없이 기기에서 처리 — 오프라인 동작, 영수증이 기기 밖으로 나가지 않는다.
 */

/** 지출 통화로 영수증 언어 모델을 고른다 (여행지 영수증 대응) */
export function scriptForCurrency(currency: string): TextRecognitionScript {
  switch (currency) {
    case 'JPY':
      return TextRecognitionScript.JAPANESE;
    case 'CNY':
    case 'TWD':
      return TextRecognitionScript.CHINESE;
    case 'KRW':
      return TextRecognitionScript.KOREAN;
    default:
      // 태국·베트남 등은 관광지 영수증 대부분이 라틴 표기
      return TextRecognitionScript.LATIN;
  }
}

export async function recognizeReceiptLines(
  imageUri: string,
  currency: string,
): Promise<OcrLine[]> {
  const result = await TextRecognition.recognize(imageUri, scriptForCurrency(currency));
  return result.blocks.flatMap((block) =>
    block.lines.map((line) => ({
      text: line.text,
      x: line.frame?.left ?? 0,
      y: line.frame?.top ?? 0,
      width: line.frame?.width ?? 0,
      height: line.frame?.height ?? 0,
    })),
  );
}
