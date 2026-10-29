shader_type spatial;
render_mode blend_mix, depth_draw_never, cull_back;
uniform float humidity=0.65;
uniform sampler2D weather_map : filter_nearest, repeat_disable;
uniform float model_day=0.0;
float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float noise(vec2 p) {
    vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
    return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
}
void fragment() {
    vec2 p=UV*vec2(16.0,8.0)+vec2(model_day*0.025,0.0);
    float n=noise(p)*0.55+noise(p*2.13)*0.28+noise(p*4.37)*0.12+noise(p*8.1)*0.05;
    vec2 uv=vec2(fract(UV.x),clamp(UV.y,0.001,0.999));
    float rain=texture(weather_map,uv).g;
    float puffs=smoothstep(0.43,0.72,n);
    float coverage=smoothstep(0.03,0.65,rain)*(0.65+0.35*puffs)+puffs*humidity*0.10;
    ALBEDO=mix(vec3(0.85,0.92,0.96),vec3(0.49,0.59,0.68),rain*0.55);
    ROUGHNESS=1.0;
    ALPHA=clamp(coverage*0.82,0.0,0.9);
}
