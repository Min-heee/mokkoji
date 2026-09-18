/**
 * 약속 내기 — 카카오맵 좌표 링크 (순수 함수).
 *
 * 기존 appointment.mapSearchUrl 은 '이름 검색'이라 같은 이름의 다른 지점으로 갈 수 있다.
 * 약속 내기는 도착을 좌표로 판정하므로 길찾기도 핀 좌표로 연다.
 * 형식(카카오맵 Web 가이드): /link/to/이름,위도,경도 (길찾기) · /link/map/이름,위도,경도 (핀 보기)
 */
import { isValidGeoPoint } from './geo';

const KAKAO_LINK = 'https://map.kakao.com/link';
const FALLBACK_NAME = '약속 장소';

/** 이름은 한 줄로, 비면 '약속 장소'. 쉼표·슬래시는 encodeURIComponent 가 막는다(구분자 오염 방지) */
function encodeName(name: string): string {
  const n = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  return encodeURIComponent(n === '' ? FALLBACK_NAME : n);
}

/** 좌표 표기: 소수 6자리(약 0.1m)까지, 지수 표기가 나오지 않게 */
function coord(v: number): string {
  return `${Number(v.toFixed(6))}`;
}

function link(kind: 'to' | 'map', name: string, lat: number, lng: number): string {
  // 좌표가 쓰레기면 좌표 링크를 만들 수 없다 → 이름 검색으로 떨어진다(항상 열 수 있는 URL 을 돌려준다)
  if (!isValidGeoPoint({ lat, lng })) return `${KAKAO_LINK}/search/${encodeName(name)}`;
  return `${KAKAO_LINK}/${kind}/${encodeName(name)},${coord(lat)},${coord(lng)}`;
}

/** 좌표 길찾기: https://map.kakao.com/link/to/{이름},{위도},{경도} */
export function mapRouteUrl(name: string, lat: number, lng: number): string {
  return link('to', name, lat, lng);
}

/** 핀 보기: https://map.kakao.com/link/map/{이름},{위도},{경도} */
export function mapPinUrl(name: string, lat: number, lng: number): string {
  return link('map', name, lat, lng);
}
