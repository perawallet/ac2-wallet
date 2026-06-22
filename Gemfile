# frozen_string_literal: true

source "https://rubygems.org"

# Ruby 3.4+ compatibility (gems removed from the default gemset).
gem 'nkf'
gem 'mutex_m'
gem 'base64'
gem 'bigdecimal'
gem 'ostruct'

gem 'fastlane'

# Load Fastlane plugins from fastlane/Pluginfile.
plugins_path = File.join(File.dirname(__FILE__), 'fastlane', 'Pluginfile')
eval_gemfile(plugins_path) if File.exist?(plugins_path)
