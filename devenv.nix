{ pkgs, ... }:

{
  dotenv.enable = true;
  packages = with pkgs; [
    git
    pgbadger
  ];
  languages.deno.enable = true;
}
