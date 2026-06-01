{ pkgs, ... }:

{
  dotenv.enable = true;
  packages = with pkgs; [
    git
  ];
}
