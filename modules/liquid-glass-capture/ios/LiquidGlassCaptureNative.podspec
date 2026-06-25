require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'LiquidGlassCaptureNative'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = package['license']
  s.author           = 'HOLYAC'
  s.homepage         = 'https://github.com/HOLYAC/liquid-glass-capture'
  s.platforms        = { :ios => '26.0' }
  s.swift_version    = '5.9'
  s.source           = { git: 'https://github.com/HOLYAC/liquid-glass-capture.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'HCaptcha'
  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
