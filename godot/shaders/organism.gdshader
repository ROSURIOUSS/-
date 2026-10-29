shader_type spatial;
uniform bool tail=false;
varying float shell_strength;
varying float vitality;
void vertex() {
    float phase=INSTANCE_CUSTOM.r*628.3;
    shell_strength=INSTANCE_CUSTOM.b;
    vitality=INSTANCE_CUSTOM.g;
    if(tail) VERTEX.x+=sin(TIME*7.0+phase+VERTEX.y*3.0)*0.5;
    else VERTEX+=NORMAL*sin(TIME*2.2+phase)*0.025;
}
void fragment() {
    float spots=sin(UV.x*28.0)*sin(UV.y*20.0);
    ALBEDO=COLOR.rgb*(0.88+spots*0.08);
    float plates=smoothstep(0.65,0.9,abs(sin(UV.x*24.0)));
    ALBEDO=mix(ALBEDO,ALBEDO*0.6+vec3(0.19,0.23,0.24)*plates,shell_strength*0.7);
    ALBEDO*=mix(0.65,1.0,clamp(vitality,0.0,1.0));
    ROUGHNESS=tail ? 0.45 : mix(0.27,0.62,shell_strength);
    SPECULAR=0.65;
    EMISSION=COLOR.rgb*0.035;
}
