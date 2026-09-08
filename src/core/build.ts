declare const __SSDSIMCITY_VERSION__: string
declare const __SSDSIMCITY_GIT_SHA__: string

export const BUILD_VERSION =
  typeof __SSDSIMCITY_VERSION__ === 'string' ? __SSDSIMCITY_VERSION__ : 'dev'
export const BUILD_SHA =
  typeof __SSDSIMCITY_GIT_SHA__ === 'string' ? __SSDSIMCITY_GIT_SHA__ : 'unknown'
export const BUILD_LABEL = `v${BUILD_VERSION} · ${BUILD_SHA}`
