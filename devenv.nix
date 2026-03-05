{ pkgs, ... }:

{
  dotenv.enable = true;
  packages = with pkgs; [
    git
  ];
  languages.deno.enable = true;
}
